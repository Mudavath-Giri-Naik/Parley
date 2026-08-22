import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, type FunctionDeclaration, type Content, type Part } from '@google/genai';
import { config } from './config';
import type { ToolDefinition } from './tools/types';

/**
 * The seller agent's reasoning can run on more than one model provider. Merchants
 * already pay for one of these; Parley should not make them buy a second.
 *
 * Providers translate protocol and nothing else. Tool execution, the audit trail,
 * and every limit stay in one place (sellerAgent.ts), so the safeguards cannot
 * drift apart between backends.
 */

export type ProviderName = 'anthropic' | 'gemini';

/** A provider-specific message array. Callers round-trip it without inspecting it. */
export type Conversation = unknown[];

export interface ToolInvocation {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolOutcome {
  ok: boolean;
  /** Serialized tool output, or the error message when ok is false. */
  content: string;
}

export interface RunTurnOptions {
  system: string;
  tools: ToolDefinition[];
  input: string;
  history: Conversation;
  /** Runs one tool. Supplied by the caller so both providers share identical behaviour. */
  execute: (call: ToolInvocation) => Promise<ToolOutcome>;
}

export interface ProviderTurn {
  reply: string;
  toolCalls: { name: string; input: unknown; ok: boolean }[];
  messages: Conversation;
  /** True when the model stopped because it hit the tool-round ceiling. */
  exhausted?: boolean;
}

export interface AgentProvider {
  name: ProviderName;
  model: string;
  runTurn(options: RunTurnOptions): Promise<ProviderTurn>;
}

export const MAX_TOOL_ROUNDS = 8;

/* -------------------------------------------------------------------------- */
/* Anthropic                                                                   */
/* -------------------------------------------------------------------------- */

class AnthropicProvider implements AgentProvider {
  readonly name = 'anthropic' as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async runTurn({ system, tools, input, history, execute }: RunTurnOptions): Promise<ProviderTurn> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const messages: Anthropic.MessageParam[] = [
      ...(history as Anthropic.MessageParam[]),
      { role: 'user', content: input },
    ];
    const toolCalls: ProviderTurn['toolCalls'] = [];

    const declarations: Anthropic.Tool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
    }));

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system,
        tools: declarations,
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
        return { reply, toolCalls, messages };
      }

      const uses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      const results = await Promise.all(
        uses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
          const outcome = await execute({
            name: use.name,
            input: (use.input ?? {}) as Record<string, unknown>,
          });
          toolCalls.push({ name: use.name, input: use.input, ok: outcome.ok });
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: outcome.ok ? undefined : true,
            content: outcome.content,
          };
        }),
      );

      // All tool results for one assistant turn go back in a single user message.
      messages.push({ role: 'user', content: results });
    }

    return { reply: '', toolCalls, messages, exhausted: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Gemini                                                                      */
/* -------------------------------------------------------------------------- */

/** Google returns these when a model is momentarily saturated rather than broken. */
const GEMINI_RETRYABLE = /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|overloaded|high demand/i;

/** A daily quota does not recover in the time we are willing to wait. Fail fast and say so. */
const GEMINI_HARD_QUOTA = /PerDay|per day|daily limit/i;

const GEMINI_MAX_ATTEMPTS = Number(process.env.GEMINI_MAX_ATTEMPTS ?? 4);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Popular Gemini models get busy in bursts. Losing a sale to a transient 503 is a
 * worse outcome than waiting a couple of seconds, so transient failures are retried
 * with backoff; anything else (a bad key, a bad request) fails immediately.
 */
async function withGeminiRetries<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (
        attempt === GEMINI_MAX_ATTEMPTS ||
        !GEMINI_RETRYABLE.test(message) ||
        GEMINI_HARD_QUOTA.test(message)
      ) {
        break;
      }
      const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
      console.warn(
        `[parley] gemini call failed (attempt ${attempt}/${GEMINI_MAX_ATTEMPTS}), retrying in ${backoff}ms: ${message.slice(0, 160)}`,
      );
      await sleep(backoff);
    }
  }
  throw lastError;
}

class GeminiProvider implements AgentProvider {
  readonly name = 'gemini' as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async runTurn({ system, tools, input, history, execute }: RunTurnOptions): Promise<ProviderTurn> {
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    const contents: Content[] = [
      ...(history as Content[]),
      { role: 'user', parts: [{ text: input }] },
    ];
    const toolCalls: ProviderTurn['toolCalls'] = [];

    const functionDeclarations: FunctionDeclaration[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // Parley's tools already describe themselves in standard JSON Schema, which
      // this field takes as-is. The older `parameters` field would need a lossy
      // translation into Gemini's own schema dialect.
      parametersJsonSchema: tool.inputSchema,
    }));

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await withGeminiRetries(() =>
        ai.models.generateContent({
          model: this.model,
          contents,
          config: {
            systemInstruction: system,
            tools: [{ functionDeclarations }],
          },
        }),
      );

      // Pushed back verbatim: on Gemini 3.x these parts carry thought signatures
      // that the next request needs to keep the model's reasoning coherent.
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const calls = response.functionCalls ?? [];

      if (!calls.length) {
        return { reply: (response.text ?? '').trim(), toolCalls, messages: contents };
      }

      contents.push({ role: 'model', parts });

      const responses = await Promise.all(
        calls.map(async (call): Promise<Part> => {
          const name = call.name ?? '';
          const args = (call.args ?? {}) as Record<string, unknown>;
          const outcome = await execute({ name, input: args });
          toolCalls.push({ name, input: args, ok: outcome.ok });
          return {
            functionResponse: {
              id: call.id,
              name,
              // A refusal is data the model should reason about, not a transport
              // error, so it comes back in the same shape as a success.
              response: outcome.ok
                ? { result: outcome.content }
                : { error: outcome.content },
            },
          };
        }),
      );

      contents.push({ role: 'user', parts: responses });
    }

    return { reply: '', toolCalls, messages: contents, exhausted: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

export class AgentNotConfiguredError extends Error {
  constructor() {
    super(
      'No model provider is configured, so the hosted seller agent is disabled. ' +
        'Set ANTHROPIC_API_KEY or GEMINI_API_KEY. The MCP tools still work without it: ' +
        'a buyer agent can connect and transact, it just cannot negotiate with anyone.',
    );
    this.name = 'AgentNotConfiguredError';
  }
}

/** True when this deployment can run the conversational seller agent at all. */
export function agentAvailable(): boolean {
  return Boolean(config.agent.anthropicApiKey || config.agent.geminiApiKey);
}

/**
 * Picks the provider. An explicit AGENT_PROVIDER wins; otherwise whichever key is
 * present, preferring Anthropic when a merchant has configured both.
 */
export function selectProvider(): AgentProvider {
  const { provider, anthropicApiKey, geminiApiKey, model, geminiModel } = config.agent;

  if (provider === 'anthropic') {
    if (!anthropicApiKey) throw new AgentNotConfiguredError();
    return new AnthropicProvider(model, anthropicApiKey);
  }
  if (provider === 'gemini') {
    if (!geminiApiKey) throw new AgentNotConfiguredError();
    return new GeminiProvider(geminiModel, geminiApiKey);
  }
  if (anthropicApiKey) return new AnthropicProvider(model, anthropicApiKey);
  if (geminiApiKey) return new GeminiProvider(geminiModel, geminiApiKey);
  throw new AgentNotConfiguredError();
}
