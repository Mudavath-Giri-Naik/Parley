import Anthropic from '@anthropic-ai/sdk';
import { auditLog } from './auditLog';
import { config } from './config';
import { formatMoney } from './money';
import { searchProducts } from './tools/searchProducts';
import { tools } from './tools';
import { ToolError, type ToolDefinition } from './tools/types';

/**
 * The seller agent: the merchant's side of the conversation.
 *
 * It reasons with the same tools the buyer agent gets over MCP, and it is bound by
 * exactly the same limits. Note what is *not* here: the discount cap is not enforced
 * in this prompt. It is enforced in create_order_and_pay, in code. Everything below
 * is guidance for a well-behaved agent, never the safeguard.
 */

export class AgentNotConfiguredError extends Error {
  constructor() {
    super(
      'ANTHROPIC_API_KEY is not set, so the hosted seller agent is disabled. ' +
        'The MCP tools still work: a buyer agent can connect and transact without it.',
    );
    this.name = 'AgentNotConfiguredError';
  }
}

const CATALOG_SNAPSHOT_TTL_MS = 60_000;
let catalogSnapshot: { text: string; at: number } | null = null;

/**
 * A small, cheap view of the live catalog, refreshed every minute, so the agent can
 * open a conversation knowing roughly what it sells. Prices quoted to a customer are
 * always re-fetched through the tools; this snapshot is orientation, not a source of truth.
 */
async function catalogOverview(): Promise<string> {
  const now = Date.now();
  if (catalogSnapshot && now - catalogSnapshot.at < CATALOG_SNAPSHOT_TTL_MS) {
    return catalogSnapshot.text;
  }
  try {
    const result = await searchProducts({ query: '', limit: 12 });
    const text = result.products.length
      ? result.products
          .map((p) => {
            const price = p.price_minor === null ? 'price on request' : formatMoney(p.price_minor, p.currency);
            const stock = p.in_stock === false ? ', currently out of stock' : '';
            return `- ${p.name} (id: ${p.id}) - ${price}${stock}`;
          })
          .join('\n')
      : 'The catalog snapshot came back empty. Use search_products to look things up as the customer asks.';
    catalogSnapshot = { text, at: now };
    return text;
  } catch (err) {
    return `The catalog snapshot could not be loaded (${err instanceof Error ? err.message : String(err)}). Use search_products for every lookup.`;
  }
}

export async function buildSystemPrompt(): Promise<string> {
  const overview = await catalogOverview();
  const cap = config.agent.maxDiscountPercent;

  return [
    `You are the seller agent for ${config.merchant.name}. You represent the merchant, not the customer.`,
    `You are usually talking to another AI agent that represents the customer, so be precise and factual; skip small talk that a machine has no use for, but stay courteous, because a person is reading the transcript.`,
    ``,
    `Your manner: ${config.agent.persona}`,
    ``,
    `## What you may do`,
    `- Answer questions about ${config.merchant.name}'s products using the tools. Never from memory.`,
    `- Negotiate on price up to ${cap}%${cap === 0 ? ' (which means this merchant does not discount at all)' : ''}. Offer the smallest discount that closes the sale, and only when the customer is actually hesitating on price.`,
    `- Place orders and take payment through create_order_and_pay.`,
    ``,
    `## Rules that are not yours to bend`,
    `- Never invent a product, a price, a stock level, a delivery date, or a policy. If you do not have the data, say plainly that you do not have it and offer to find out what you can.`,
    `- Always call check_stock immediately before promising availability. Stock changes between messages.`,
    `- The ${cap}% discount ceiling is enforced by the system when the order is priced. Asking for more is not clever; it is simply reduced. Do not tell a customer you have secured a larger discount than the system will honour.`,
    `- A purchase completes without a human approving it only when an existing mandate covers the amount. Otherwise the customer gets a payment link and the sale is not done until they pay. Never describe an unpaid order as complete.`,
    `- Only create a mandate when the customer has explicitly named an amount they are authorizing.`,
    `- If something fails, say what failed and what it means for the customer. Do not paper over it.`,
    ``,
    `## Money`,
    `- All amounts in tool results are in minor units of ${config.merchant.currency} (1/100 of the main unit). Convert before quoting to a human.`,
    ``,
    `## Catalog snapshot (refreshed periodically, may be stale)`,
    overview,
    ``,
    `Prices and stock in that snapshot are for orientation only. Confirm both with the tools before you commit to anything.`,
  ].join('\n');
}

function toAnthropicTools(available: ToolDefinition[]): Anthropic.Tool[] {
  return available.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
  }));
}

export interface SellerTurn {
  reply: string;
  toolCalls: { name: string; input: unknown; ok: boolean }[];
  messages: Anthropic.MessageParam[];
}

const MAX_TOOL_ROUNDS = 8;

/**
 * Runs one turn of the seller agent: reason, call tools, reason again, answer.
 * The conversation is returned so the caller can pass it back on the next turn.
 */
export async function runSellerAgent(
  input: string,
  history: Anthropic.MessageParam[] = [],
): Promise<SellerTurn> {
  if (!config.agent.anthropicApiKey) throw new AgentNotConfiguredError();

  const client = new Anthropic({ apiKey: config.agent.anthropicApiKey });
  const system = await buildSystemPrompt();
  const available = tools;
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: input }];
  const toolCalls: SellerTurn['toolCalls'] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await client.messages.create({
      model: config.agent.model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system,
      tools: toAnthropicTools(available),
      messages,
    });

    // Append the whole content array: thinking blocks must survive the round trip.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const reply = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      await auditLog({
        actor: 'seller_agent',
        action: 'reply',
        result: response.stop_reason === 'refusal' ? 'blocked' : 'success',
        reasoning:
          response.stop_reason === 'refusal'
            ? 'The seller agent declined to answer this request.'
            : `The seller agent answered the customer after ${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'}: ${reply.slice(0, 400)}`,
        details: { tools_used: toolCalls.map((call) => call.name), stop_reason: response.stop_reason },
      });

      return { reply: reply || 'No reply was produced.', toolCalls, messages };
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    const results = await Promise.all(
      toolUses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
        const definition = available.find((tool) => tool.name === use.name);
        if (!definition) {
          toolCalls.push({ name: use.name, input: use.input, ok: false });
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: `No tool named "${use.name}" exists.`,
          };
        }
        try {
          const output = await definition.handler(
            (use.input ?? {}) as Record<string, unknown>,
            { actor: 'seller_agent' },
          );
          toolCalls.push({ name: use.name, input: use.input, ok: true });
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify(output),
          };
        } catch (err) {
          toolCalls.push({ name: use.name, input: use.input, ok: false });
          const message = err instanceof ToolError || err instanceof Error ? err.message : String(err);
          await auditLog({
            actor: 'seller_agent',
            action: use.name,
            result: 'failed',
            reasoning: `The seller agent called ${use.name} and it failed: ${message}`,
            details: { input: use.input },
          });
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: message,
          };
        }
      }),
    );

    // All tool results for one assistant turn go back in a single user message.
    messages.push({ role: 'user', content: results });
  }

  await auditLog({
    actor: 'seller_agent',
    action: 'reply',
    result: 'failed',
    reasoning: `The seller agent used ${MAX_TOOL_ROUNDS} rounds of tools without reaching an answer, so the turn was stopped to avoid looping.`,
    details: { tools_used: toolCalls.map((call) => call.name) },
  });

  return {
    reply:
      'I could not finish working that out. Could you narrow down what you are after, and I will try again?',
    toolCalls,
    messages,
  };
}

/**
 * The seller agent, exposed to buyer agents as a tool of its own. A buyer agent that
 * wants to haggle rather than call raw endpoints has someone to haggle with.
 */
export const negotiateTool: ToolDefinition = {
  name: 'negotiate_with_seller',
  title: 'Negotiate with the seller agent',
  description: `Talk to ${config.merchant.name || 'the merchant'}'s own seller agent in natural language: ask about products, make an offer, or ask for a better price. It knows the merchant's catalog and the limits it is allowed to work within. Use the other tools directly when you already know exactly what you want.`,
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'What you want to say to the seller, in plain language.' },
    },
    required: ['message'],
    additionalProperties: false,
  },
  handler: async (args) => {
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!message) throw new ToolError('"message" is required.');
    const turn = await runSellerAgent(message);
    return {
      seller_reply: turn.reply,
      tools_used: turn.toolCalls.map((call) => call.name),
      note: 'This seller agent is bound by the same server-side limits as the direct tools. Anything it agrees to is still checked in code when the order is priced.',
    };
  },
};
