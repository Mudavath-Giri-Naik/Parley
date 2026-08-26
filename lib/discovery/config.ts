/**
 * Discovery Service configuration.
 *
 * The same rule Parley lives by applies here: no merchant name, domain, price or
 * product value appears in this source tree. Everything specific to a deployment
 * arrives through the environment or through the merchant's own catalog.
 *
 * This module deliberately does not import Parley's tool or MCP layers. It reads
 * `lib/config` for the values both services legitimately share (the catalog URLs,
 * the currency, the merchant's display name) and adds only what discovery needs.
 */

import { config as parleyConfig, publicBaseUrl } from '@/lib/config';

/** The AI crawlers a merchant is usually asked about. Overridable; never merchant-specific. */
const DEFAULT_CRAWLERS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];

/**
 * Query parameters appended to the catalog listing call.
 *
 * A storefront that hides sold-out products by default would otherwise drop them
 * from the feed entirely, which reads to a shopping agent as "this product does not
 * exist" rather than "this product is out of stock". Parley already sends `q`,
 * `query` and `search` together for the same reason: the alias that matches wins and
 * the rest are ignored. DISCOVERY_CATALOG_PARAMS replaces these when a storefront
 * spells it differently.
 */
const DEFAULT_CATALOG_PARAMS: Record<string, string> = {
  include_sold_out: 'true',
  include_out_of_stock: 'true',
  include_unavailable: 'true',
};

const issues: string[] = [];

function optional(key: string, fallback = ''): string {
  const raw = process.env[key];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function numberIn(key: string, fallback: number, min: number, max: number): number {
  const raw = optional(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    issues.push(`${key} must be a number (got "${raw}").`);
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function list(key: string, fallback: string[]): string[] {
  const raw = optional(key);
  if (!raw) return fallback;
  const names = raw.split(',').map((n) => n.trim()).filter(Boolean);
  return names.length ? [...new Set(names)] : fallback;
}

function jsonRecord(key: string, fallback: Record<string, string>): Record<string, string> {
  const raw = optional(key);
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = String(v);
    return out;
  } catch {
    issues.push(`${key} must be a JSON object of {param: value}.`);
    return fallback;
  }
}

/**
 * The public origin of the merchant's own storefront.
 *
 * Derived from the catalog API the merchant already configured for Parley, because
 * a storefront's API and its shop pages nearly always share an origin. Set
 * STOREFRONT_URL when they do not — the crawler checker reads robots.txt there, and
 * product pages are linked there.
 */
function storefrontOrigin(): string | undefined {
  const explicit = optional('STOREFRONT_URL');
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {
      issues.push(`STOREFRONT_URL must be an absolute http(s) URL (got "${explicit}").`);
    }
  }
  for (const candidate of [parleyConfig.merchant.searchApi, parleyConfig.merchant.stockApi]) {
    if (!candidate) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      // Parley's own config already reports a malformed URL here.
    }
  }
  return undefined;
}

export interface DiscoveryConfig {
  /** How long catalog reads may be reused. Capped at five minutes by design. */
  cacheTtlMs: number;
  /** Upper bound on how many catalog records the feed and manifest will walk. */
  catalogLimit: number;
  catalogParams: Record<string, string>;
  /** Collapse catalog rows that share a title into one product with several variants. */
  groupVariants: boolean;
  storefrontOrigin?: string;
  /** Template for the merchant's own product page, e.g. https://shop.example.com/p/{id}. */
  productUrlTemplate?: string;
  feedTargetCountry?: string;
  crawlers: string[];
  appearance: {
    questions: string[];
    openaiApiKey?: string;
    openaiModel: string;
    perplexityApiKey?: string;
    perplexityModel: string;
    geminiApiKey?: string;
    geminiModel: string;
    anthropicApiKey?: string;
    anthropicModel: string;
  };
}

export const discoveryConfig: DiscoveryConfig = {
  // Five minutes is the ceiling the brief allows; 60s is the default because a price
  // or a stock level going stale is the one failure this service must not have.
  cacheTtlMs: numberIn('DISCOVERY_CACHE_TTL_MS', 60_000, 0, 300_000),
  catalogLimit: numberIn('DISCOVERY_CATALOG_LIMIT', 500, 1, 5_000),
  catalogParams: jsonRecord('DISCOVERY_CATALOG_PARAMS', DEFAULT_CATALOG_PARAMS),
  groupVariants: optional('DISCOVERY_GROUP_VARIANTS', 'true').toLowerCase() !== 'false',
  storefrontOrigin: storefrontOrigin(),
  productUrlTemplate: optional('DISCOVERY_PRODUCT_URL_TEMPLATE') || undefined,
  feedTargetCountry: optional('DISCOVERY_FEED_TARGET_COUNTRY').toUpperCase() || undefined,
  crawlers: list('DISCOVERY_CRAWLERS', DEFAULT_CRAWLERS),
  appearance: {
    questions: (optional('APPEARANCE_QUESTIONS') || '')
      .split('|')
      .map((q) => q.trim())
      .filter(Boolean),
    openaiApiKey: optional('OPENAI_API_KEY') || undefined,
    openaiModel: optional('OPENAI_MODEL', 'gpt-5.1'),
    perplexityApiKey: optional('PERPLEXITY_API_KEY') || undefined,
    perplexityModel: optional('PERPLEXITY_MODEL', 'sonar'),
    geminiApiKey: optional('GEMINI_API_KEY') || undefined,
    geminiModel: optional('APPEARANCE_GEMINI_MODEL', parleyConfig.agent.geminiModel),
    anthropicApiKey: optional('ANTHROPIC_API_KEY') || undefined,
    anthropicModel: optional('APPEARANCE_ANTHROPIC_MODEL', parleyConfig.agent.model),
  },
};

export const discoveryIssues = issues;

/** Re-exported so route handlers need only one import for the shared values. */
export { parleyConfig, publicBaseUrl };

/** The merchant's display name, or a neutral placeholder when unconfigured. */
export function merchantName(): string {
  return parleyConfig.merchant.name || 'Unconfigured merchant';
}

/** ISO 4217 code every price in this service is denominated in. */
export function currency(): string {
  return parleyConfig.merchant.currency;
}
