import {
  AgentNotConfiguredError,
  MAX_TOOL_ROUNDS,
  agentAvailable,
  selectProvider,
  type Conversation,
  type ToolInvocation,
  type ToolOutcome,
} from './agentProviders';
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
 *
 * Which model does the reasoning is a deployment detail (see agentProviders.ts).
 * Tool execution and auditing live here, once, so no provider can drift from the rules.
 */

export { AgentNotConfiguredError };

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

export interface SellerTurn {
  reply: string;
  toolCalls: { name: string; input: unknown; ok: boolean }[];
  /** Provider-specific conversation state. Pass it back verbatim to continue the thread. */
  messages: Conversation;
  provider: string;
  model: string;
}

/**
 * Tool arguments are composed by a language model, so their shape is not fixed and
 * storing them wholesale would put unbounded, model-authored content — including a
 * customer's real name — into the audit trail. Only these keys are ever recorded.
 * `customer_name` is deliberately absent.
 */
const LOGGABLE_ARGUMENT_KEYS = [
  'product_id',
  'order_id',
  'quantity',
  'discount_percent',
  'customer_ref',
  'limit',
] as const;

function safeArguments(input: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of LOGGABLE_ARGUMENT_KEYS) {
    const value = input?.[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Executes one tool on the seller agent's behalf. Every provider routes through
 * this, so a refusal, a failure, and an audit entry look the same on all of them.
 */
async function executeTool(
  available: ToolDefinition[],
  call: ToolInvocation,
): Promise<ToolOutcome> {
  const definition = available.find((tool) => tool.name === call.name);
  if (!definition) {
    return { ok: false, content: `No tool named "${call.name}" exists.` };
  }
  try {
    const output = await definition.handler(call.input, { actor: 'seller_agent' });
    return { ok: true, content: JSON.stringify(output) };
  } catch (err) {
    const message = err instanceof ToolError || err instanceof Error ? err.message : String(err);
    await auditLog({
      actor: 'seller_agent',
      action: call.name,
      result: 'failed',
      reasoning: `The seller agent called ${call.name} and it failed: ${message}`,
      details: { tool_name: call.name, ...safeArguments(call.input) },
    });
    return { ok: false, content: message };
  }
}

/**
 * Runs one turn of the seller agent: reason, call tools, reason again, answer.
 * The conversation is returned so the caller can pass it back on the next turn.
 */
export async function runSellerAgent(
  input: string,
  history: Conversation = [],
): Promise<SellerTurn> {
  if (!agentAvailable()) throw new AgentNotConfiguredError();

  const provider = selectProvider();
  const system = await buildSystemPrompt();
  const available = tools;

  const turn = await provider.runTurn({
    system,
    tools: available,
    input,
    history,
    execute: (call) => executeTool(available, call),
  });

  if (turn.exhausted) {
    await auditLog({
      actor: 'seller_agent',
      action: 'reply',
      result: 'failed',
      reasoning: `The seller agent used ${MAX_TOOL_ROUNDS} rounds of tools without reaching an answer, so the turn was stopped to avoid looping.`,
      details: {
        tools_used: turn.toolCalls.map((call) => call.name),
        provider: provider.name,
        model: provider.model,
      },
    });
    return {
      reply:
        'I could not finish working that out. Could you narrow down what you are after, and I will try again?',
      toolCalls: turn.toolCalls,
      messages: turn.messages,
      provider: provider.name,
      model: provider.model,
    };
  }

  await auditLog({
    actor: 'seller_agent',
    action: 'reply',
    result: turn.reply ? 'success' : 'blocked',
    reasoning: turn.reply
      ? `The seller agent answered the customer after ${turn.toolCalls.length} tool call${turn.toolCalls.length === 1 ? '' : 's'}: ${turn.reply.slice(0, 400)}`
      : 'The seller agent produced no answer for this request.',
    details: {
      tools_used: turn.toolCalls.map((call) => call.name),
      provider: provider.name,
      model: provider.model,
    },
  });

  return {
    reply: turn.reply || 'No reply was produced.',
    toolCalls: turn.toolCalls,
    messages: turn.messages,
    provider: provider.name,
    model: provider.model,
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
