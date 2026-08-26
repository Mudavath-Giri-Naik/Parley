/**
 * Appearance probes — the observation log, not a guarantee.
 *
 * The honest framing matters more here than the code does. Nothing in this file can
 * make a merchant appear in an AI assistant's answer, and nothing here should be read
 * as evidence that it will. What it does is ask a buyer-shaped question of whichever
 * assistants expose a programmatic search-grounded interface, record what came back
 * verbatim with a timestamp, and note whether the merchant was named. That is an
 * observation of one answer at one moment, from one API, and it is labelled as such
 * everywhere it is surfaced.
 *
 * Three things it deliberately does not do:
 *
 *   - It does not fabricate a result for a platform it could not reach. A platform
 *     without a testable interface is reported as untestable, with the reason.
 *   - It does not claim the API it queried is the same retrieval stack as the
 *     consumer product of the same name. Where those differ, the difference is stated
 *     on the record itself.
 *   - It does not call anything a ranking. Nothing here observes position.
 */

import { discoveryConfig, merchantName, parleyConfig } from './config';
import { query } from '@/lib/db';
import { listCatalog, extra, type CatalogEntry } from './catalog';
import { formatMoney } from '@/lib/money';

export const APPEARANCE_DISCLAIMER =
  'Observed appearance, not a guaranteed ranking. Each row records what one assistant returned ' +
  'for one question at one moment, through its API. It is not a measurement of position, not a ' +
  'prediction, and not a commitment that the same question will return the same answer again.';

export type PlatformId = 'chatgpt' | 'gemini' | 'perplexity' | 'claude';

export interface ProbeResult {
  platform: PlatformId;
  /** The API actually queried, which may not be the consumer product of the same name. */
  via: string;
  testable: boolean;
  /** Why not, when testable is false. Never left vague. */
  reason?: string;
  question?: string;
  answer?: string;
  /** Whether the merchant's name or domain appeared in the answer or its citations. */
  mentioned?: boolean;
  citations?: string[];
  error?: string;
  observedAt: string;
}

/* ------------------------------------------------------------- questions --- */

/**
 * Buyer-shaped questions, built from the merchant's own catalog.
 *
 * "best {category} under {price}" is the shape a person actually types. Both halves
 * come from live catalog data — the categories the merchant sells and a price band
 * near the top of that category's range — so this file names no product and no
 * category of its own.
 */
export function buildQuestions(entries: CatalogEntry[], limit = 3): string[] {
  if (discoveryConfig.appearance.questions.length) {
    return discoveryConfig.appearance.questions.slice(0, limit);
  }

  const byCategory = new Map<string, number[]>();
  for (const entry of entries) {
    const category = extra(entry.raw, 'category') ?? entry.product.name;
    const price = entry.product.price_minor;
    if (price === null) continue;
    const key = category.split('>').pop()!.trim().toLowerCase();
    if (!key) continue;
    byCategory.set(key, [...(byCategory.get(key) ?? []), price]);
  }

  const questions: string[] = [];
  const ranked = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [category, prices] of ranked) {
    if (questions.length >= limit) break;
    // A band a shopper would plausibly state: rounded up from the dearest item in
    // the category, so the whole category is inside it.
    const ceiling = Math.max(...prices);
    const rounded = Math.ceil(ceiling / 50_000) * 50_000;
    questions.push(`best ${category} under ${formatMoney(rounded)} to buy online in India`);
  }

  if (!questions.length) {
    questions.push(`where can I buy from ${merchantName()} online`);
  }
  return questions;
}

/* ------------------------------------------------------------- detection --- */

/** The strings that would count as this merchant having been named. */
function needles(): string[] {
  const values = [merchantName()];
  if (discoveryConfig.storefrontOrigin) {
    try {
      values.push(new URL(discoveryConfig.storefrontOrigin).hostname);
    } catch {
      // Ignore a malformed origin; Parley's own config already reports it.
    }
  }
  return values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 2);
}

function wasMentioned(answer: string, citations: string[]): boolean {
  const haystack = `${answer} ${citations.join(' ')}`.toLowerCase();
  return needles().some((needle) => haystack.includes(needle));
}

/* ------------------------------------------------------------- providers --- */

interface Provider {
  platform: PlatformId;
  via: string;
  /** Null when this platform can be queried; a reason string when it cannot. */
  blocked(): string | null;
  ask(question: string): Promise<{ answer: string; citations: string[] }>;
}

const providers: Provider[] = [
  {
    platform: 'gemini',
    via: 'Google Gemini API with Google Search grounding',
    blocked() {
      return discoveryConfig.appearance.geminiApiKey
        ? null
        : 'GEMINI_API_KEY is not set, so Gemini could not be queried.';
    },
    async ask(question) {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: discoveryConfig.appearance.geminiApiKey! });

      let response;
      try {
        response = await ai.models.generateContent({
          model: discoveryConfig.appearance.geminiModel,
          contents: question,
          // Grounding is the whole point. Without it the model answers from training
          // data, which says nothing about whether this merchant is discoverable now —
          // so a failure here is reported, never quietly retried without the tool.
          config: { tools: [{ googleSearch: {} }] },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/RESOURCE_EXHAUSTED|\b429\b/.test(message)) {
          throw new Error(
            'Google Search grounding was refused for this API key (quota exhausted or not ' +
              'included in its tier). Ungrounded generation is not substituted: an answer from ' +
              'training data would say nothing about whether this merchant is findable today.',
          );
        }
        throw new Error(message.replace(/\s+/g, ' ').slice(0, 400));
      }

      const grounding = response.candidates?.[0]?.groundingMetadata;
      const citations = (grounding?.groundingChunks ?? [])
        .map((chunk) => chunk.web?.uri ?? chunk.web?.title ?? '')
        .filter(Boolean);

      if (!grounding) {
        throw new Error(
          'Gemini answered without grounding metadata, so the reply was not search-backed and ' +
            'is not recorded as an observation of what a shopper would be told.',
        );
      }
      return { answer: (response.text ?? '').trim(), citations };
    },
  },
  {
    platform: 'claude',
    via: 'Anthropic Messages API with the server-side web_search tool',
    blocked() {
      return discoveryConfig.appearance.anthropicApiKey
        ? null
        : 'ANTHROPIC_API_KEY is not set, so Claude could not be queried.';
    },
    async ask(question) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: discoveryConfig.appearance.anthropicApiKey! });
      const response = await client.messages.create({
        model: discoveryConfig.appearance.anthropicModel,
        max_tokens: 1024,
        messages: [{ role: 'user', content: question }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 } as never],
      });

      const answer = response.content
        .filter((block): block is { type: 'text'; text: string } & typeof block => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      const citations: string[] = [];
      for (const block of response.content) {
        const record = block as unknown as { citations?: { url?: string }[] };
        for (const citation of record.citations ?? []) {
          if (citation.url) citations.push(citation.url);
        }
      }
      return { answer, citations };
    },
  },
  {
    platform: 'perplexity',
    via: 'Perplexity Sonar API',
    blocked() {
      return discoveryConfig.appearance.perplexityApiKey
        ? null
        : 'PERPLEXITY_API_KEY is not set, so Perplexity could not be queried.';
    },
    async ask(question) {
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${discoveryConfig.appearance.perplexityApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: discoveryConfig.appearance.perplexityModel,
          messages: [{ role: 'user', content: question }],
        }),
      });
      if (!response.ok) {
        throw new Error(`Perplexity returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        citations?: string[];
        search_results?: { url?: string }[];
      };
      const citations = body.citations ?? (body.search_results ?? []).map((r) => r.url ?? '').filter(Boolean);
      return { answer: (body.choices?.[0]?.message?.content ?? '').trim(), citations };
    },
  },
  {
    platform: 'chatgpt',
    // Named precisely. ChatGPT the product has no API; this is the closest
    // programmatic surface OpenAI offers, and it is not the same retrieval path.
    via: 'OpenAI Responses API with the web_search tool (a proxy for ChatGPT, not ChatGPT itself)',
    blocked() {
      return discoveryConfig.appearance.openaiApiKey
        ? null
        : 'OPENAI_API_KEY is not set. Note that even with a key this queries the OpenAI API, not ' +
            'the ChatGPT product, which exposes no programmatic interface and no shopping-surface API.';
    },
    async ask(question) {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${discoveryConfig.appearance.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: discoveryConfig.appearance.openaiModel,
          input: question,
          tools: [{ type: 'web_search' }],
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const body = (await response.json()) as {
        output_text?: string;
        output?: { content?: { text?: string; annotations?: { url?: string }[] }[] }[];
      };
      const citations: string[] = [];
      let answer = body.output_text ?? '';
      for (const item of body.output ?? []) {
        for (const part of item.content ?? []) {
          if (!body.output_text && part.text) answer += part.text;
          for (const annotation of part.annotations ?? []) {
            if (annotation.url) citations.push(annotation.url);
          }
        }
      }
      return { answer: answer.trim(), citations };
    },
  },
];

/* --------------------------------------------------------------- storage --- */

const MAX_ANSWER_CHARS = 4_000;

/**
 * Persists one probe.
 *
 * The dedicated table is preferred. When it is absent — a merchant who has not run
 * `supabase/0002_discovery.sql` — the probe still lands, in Parley's existing
 * append-only audit_log under a system actor, because a proof log that silently
 * discards its evidence when a migration was skipped is worse than a slightly noisier
 * audit trail. `storedIn` reports which happened, so the report never implies more
 * than it has.
 */
export async function recordProbe(result: ProbeResult): Promise<'table' | 'audit_log' | 'none'> {
  if (!parleyConfig.db.enabled) return 'none';

  const answer = (result.answer ?? '').slice(0, MAX_ANSWER_CHARS);
  const details = {
    platform: result.platform,
    via: result.via,
    testable: result.testable,
    reason: result.reason,
    mentioned: result.mentioned,
    citations: (result.citations ?? []).slice(0, 20),
    error: result.error,
  };

  try {
    await query(
      `INSERT INTO discovery_appearance_log
         (merchant_id, platform, via, testable, question, answer, mentioned, citations, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        result.platform,
        result.via,
        result.testable,
        result.question ?? null,
        answer || null,
        result.mentioned ?? null,
        JSON.stringify((result.citations ?? []).slice(0, 20)),
        result.error ?? result.reason ?? null,
      ],
    );
    return 'table';
  } catch {
    // Falls through to the audit log below. The dedicated table is optional.
  }

  try {
    await query(
      `INSERT INTO audit_log (merchant_id, actor, action, result, reasoning, details)
       VALUES ($1, 'system', 'discovery_appearance_probe', $2, $3, $4)`,
      [
        result.error ? 'failed' : result.testable ? 'info' : 'blocked',
        result.testable
          ? `Asked ${result.platform} "${result.question}" and ${
              result.mentioned ? 'the merchant was named' : 'the merchant was not named'
            } in the answer. ${APPEARANCE_DISCLAIMER}`
          : `${result.platform} could not be tested: ${result.reason}`,
        JSON.stringify({ ...details, question: result.question, answer }),
      ],
    );
    return 'audit_log';
  } catch (err) {
    console.error('[discovery] appearance probe could not be persisted', err);
    return 'none';
  }
}

export interface StoredProbe {
  observedAt: string;
  platform: string;
  via: string;
  testable: boolean;
  question: string | null;
  answer: string | null;
  mentioned: boolean | null;
  citations: string[];
  error: string | null;
}

/** Reads the probe history back, from whichever store holds it. */
export async function readProbes(limit = 50): Promise<{ source: string; probes: StoredProbe[] }> {
  if (!parleyConfig.db.enabled) return { source: 'none', probes: [] };
  const capped = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);

  try {
    const rows = await query<Record<string, unknown>>(
      `SELECT created_at, platform, via, testable, question, answer, mentioned, citations, error
         FROM discovery_appearance_log
        WHERE merchant_id = $1
        ORDER BY created_at DESC
        LIMIT ${capped}`,
    );
    return {
      source: 'discovery_appearance_log',
      probes: rows.map((row) => ({
        observedAt: new Date(row.created_at as string).toISOString(),
        platform: String(row.platform),
        via: String(row.via ?? ''),
        testable: Boolean(row.testable),
        question: (row.question as string) ?? null,
        answer: (row.answer as string) ?? null,
        mentioned: row.mentioned === null ? null : Boolean(row.mentioned),
        citations: Array.isArray(row.citations) ? (row.citations as string[]) : [],
        error: (row.error as string) ?? null,
      })),
    };
  } catch {
    // The dedicated table is absent; read the fallback.
  }

  try {
    const rows = await query<Record<string, unknown>>(
      `SELECT created_at, details, reasoning
         FROM audit_log
        WHERE merchant_id = $1 AND action = 'discovery_appearance_probe'
        ORDER BY created_at DESC
        LIMIT ${capped}`,
    );
    return {
      source: 'audit_log',
      probes: rows.map((row) => {
        const details = (row.details ?? {}) as Record<string, unknown>;
        return {
          observedAt: new Date(row.created_at as string).toISOString(),
          platform: String(details.platform ?? 'unknown'),
          via: String(details.via ?? ''),
          testable: Boolean(details.testable),
          question: (details.question as string) ?? null,
          answer: (details.answer as string) ?? null,
          mentioned: details.mentioned === undefined ? null : Boolean(details.mentioned),
          citations: Array.isArray(details.citations) ? (details.citations as string[]) : [],
          error: (details.error as string) ?? (details.reason as string) ?? null,
        };
      }),
    };
  } catch (err) {
    console.error('[discovery] appearance history could not be read', err);
    return { source: 'none', probes: [] };
  }
}

/* ------------------------------------------------------------- the audit --- */

export interface AuditRun {
  startedAt: string;
  disclaimer: string;
  questions: string[];
  results: ProbeResult[];
  storedIn: string;
  /** Platforms this run could not test, and why — always stated, never omitted. */
  untestable: { platform: PlatformId; via: string; reason: string }[];
}

/**
 * Runs one round of probes: every configured platform, every generated question.
 *
 * Platforms are asked in parallel and questions in sequence, so one slow assistant
 * does not decide how long the whole run takes and no assistant is rate-limited by
 * this job talking over itself.
 */
export async function runAppearanceAudit(options: { questionLimit?: number } = {}): Promise<AuditRun> {
  const startedAt = new Date().toISOString();
  const entries = await listCatalog().catch(() => [] as CatalogEntry[]);
  const questions = buildQuestions(entries, options.questionLimit ?? 2);

  const results: ProbeResult[] = [];
  const untestable: AuditRun['untestable'] = [];

  const runs = providers.map(async (provider) => {
    const blocked = provider.blocked();
    if (blocked) {
      untestable.push({ platform: provider.platform, via: provider.via, reason: blocked });
      return [
        {
          platform: provider.platform,
          via: provider.via,
          testable: false,
          reason: blocked,
          observedAt: new Date().toISOString(),
        } satisfies ProbeResult,
      ];
    }

    const own: ProbeResult[] = [];
    for (const question of questions) {
      try {
        const { answer, citations } = await provider.ask(question);
        own.push({
          platform: provider.platform,
          via: provider.via,
          testable: true,
          question,
          answer,
          citations,
          mentioned: wasMentioned(answer, citations),
          observedAt: new Date().toISOString(),
        });
      } catch (err) {
        own.push({
          platform: provider.platform,
          via: provider.via,
          testable: true,
          question,
          error: err instanceof Error ? err.message : String(err),
          observedAt: new Date().toISOString(),
        });
      }
    }
    return own;
  });

  for (const batch of await Promise.all(runs)) results.push(...batch);

  const stored = new Set<string>();
  for (const result of results) stored.add(await recordProbe(result));

  return {
    startedAt,
    disclaimer: APPEARANCE_DISCLAIMER,
    questions,
    results,
    storedIn: [...stored].join(', ') || 'none',
    untestable,
  };
}
