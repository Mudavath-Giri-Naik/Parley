/**
 * Parley configuration.
 *
 * Every merchant-specific value in Parley lives here and arrives from environment
 * variables. Nothing in this repository knows the name of any particular business,
 * and nothing should ever be added that does.
 */

export type PriceUnit = 'major' | 'minor';

/** Which model provider reasons for the seller agent. `auto` picks whichever key is set. */
export type AgentProviderChoice = 'auto' | 'anthropic' | 'gemini';

/**
 * The canonical product fields Parley speaks. FIELD_MAP maps these onto whatever
 * the merchant's own API happens to call them.
 */
export const CANONICAL_PRODUCT_FIELDS = [
  'id',
  'name',
  'price',
  'stock',
  'currency',
  'description',
  'image',
  'url',
  'size',
  'color',
] as const;

export type CanonicalProductField = (typeof CANONICAL_PRODUCT_FIELDS)[number];
export type FieldMap = Partial<Record<CanonicalProductField, string>>;

export interface ParleyConfig {
  merchant: {
    name: string;
    searchApi: string;
    stockApi: string;
    orderApi: string;
    orderStatusApi: string;
    apiKey?: string;
    apiKeyHeader: string;
    fieldMap: FieldMap;
    priceUnit: PriceUnit;
    currency: string;
    outOfStockPattern: RegExp;
  };
  agent: {
    persona: string;
    maxDiscountPercent: number;
    provider: AgentProviderChoice;
    model: string;
    anthropicApiKey?: string;
    geminiModel: string;
    geminiApiKey?: string;
  };
  payments: {
    razorpayKeyId?: string;
    razorpayKeySecret?: string;
    callbackUrl?: string;
    enabled: boolean;
  };
  mandates: {
    spendCapDefault: number;
    defaultTtlDays: number;
  };
  db: {
    url?: string;
    enabled: boolean;
  };
  server: {
    publicUrl?: string;
    apiKey?: string;
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Parley is not configured correctly:\n - ${issues.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

const issues: string[] = [];

function required(key: string): string {
  const raw = process.env[key];
  if (!raw || !raw.trim()) {
    issues.push(`${key} is required but not set. See .env.example.`);
    return '';
  }
  return raw.trim();
}

function optional(key: string, fallback = ''): string {
  const raw = process.env[key];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function requiredUrl(key: string): string {
  const value = required(key);
  if (value && !/^https?:\/\//i.test(value)) {
    issues.push(`${key} must be an absolute http(s) URL (got "${value}").`);
  }
  return value.replace(/\/+$/, '');
}

function optionalUrl(key: string, fallback: string): string {
  const value = optional(key);
  if (!value) return fallback;
  if (!/^https?:\/\//i.test(value)) {
    issues.push(`${key} must be an absolute http(s) URL (got "${value}").`);
  }
  return value.replace(/\/+$/, '');
}

function numberIn(key: string, fallback: number, min: number, max: number): number {
  const raw = optional(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    issues.push(`${key} must be a number between ${min} and ${max} (got "${raw}").`);
    return fallback;
  }
  return parsed;
}

function parseFieldMap(): FieldMap {
  const raw = optional('FIELD_MAP');
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push('FIELD_MAP must be valid JSON, for example {"name":"title","price":"cost"}.');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    issues.push('FIELD_MAP must be a JSON object of {parleyField: merchantField}.');
    return {};
  }
  const map: FieldMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(CANONICAL_PRODUCT_FIELDS as readonly string[]).includes(key)) {
      issues.push(
        `FIELD_MAP key "${key}" is not a Parley field. Valid keys: ${CANONICAL_PRODUCT_FIELDS.join(', ')}.`,
      );
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      issues.push(`FIELD_MAP value for "${key}" must be a non-empty string.`);
      continue;
    }
    map[key as CanonicalProductField] = value.trim();
  }
  return map;
}

function parsePriceUnit(): PriceUnit {
  const raw = optional('PRICE_UNIT', 'major').toLowerCase();
  if (raw !== 'major' && raw !== 'minor') {
    issues.push('PRICE_UNIT must be either "major" (rupees, dollars) or "minor" (paise, cents).');
    return 'major';
  }
  return raw;
}

function parseAgentProvider(): AgentProviderChoice {
  const raw = optional('AGENT_PROVIDER', 'auto').toLowerCase();
  if (raw !== 'auto' && raw !== 'anthropic' && raw !== 'gemini') {
    issues.push('AGENT_PROVIDER must be "auto", "anthropic", or "gemini".');
    return 'auto';
  }
  return raw;
}

function parseOutOfStockPattern(): RegExp {
  const raw = optional(
    'OUT_OF_STOCK_PATTERN',
    'out[_\\s-]?of[_\\s-]?stock|sold[_\\s-]?out|insufficient[_\\s-]?stock|no[_\\s-]?stock|unavailable',
  );
  try {
    return new RegExp(raw, 'i');
  } catch {
    issues.push(`OUT_OF_STOCK_PATTERN is not a valid regular expression: "${raw}".`);
    return /out[_\s-]?of[_\s-]?stock/i;
  }
}

const merchantName = required('MERCHANT_NAME');
const searchApi = requiredUrl('MERCHANT_SEARCH_API');
const stockApi = requiredUrl('MERCHANT_STOCK_API');
const orderApi = requiredUrl('MERCHANT_ORDER_API');

const razorpayKeyId = optional('RAZORPAY_KEY_ID');
const razorpayKeySecret = optional('RAZORPAY_KEY_SECRET');
if ((razorpayKeyId && !razorpayKeySecret) || (!razorpayKeyId && razorpayKeySecret)) {
  issues.push('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set together.');
}

const dbUrl = optional('PARLEY_DB_URL');

export const config: ParleyConfig = {
  merchant: {
    name: merchantName,
    searchApi,
    stockApi,
    orderApi,
    orderStatusApi: optionalUrl('MERCHANT_ORDER_STATUS_API', orderApi),
    apiKey: optional('MERCHANT_API_KEY') || undefined,
    apiKeyHeader: optional('MERCHANT_API_KEY_HEADER', 'Authorization'),
    fieldMap: parseFieldMap(),
    priceUnit: parsePriceUnit(),
    currency: optional('CURRENCY', 'INR').toUpperCase(),
    outOfStockPattern: parseOutOfStockPattern(),
  },
  agent: {
    persona: optional('AGENT_PERSONA', 'Friendly, concise, never pushy'),
    maxDiscountPercent: numberIn('MAX_DISCOUNT_PERCENT', 10, 0, 100),
    provider: parseAgentProvider(),
    model: optional('AGENT_MODEL', 'claude-opus-5'),
    anthropicApiKey: optional('ANTHROPIC_API_KEY') || undefined,
    geminiModel: optional('GEMINI_MODEL', 'gemini-3.7-flash'),
    geminiApiKey: optional('GEMINI_API_KEY') || undefined,
  },
  payments: {
    razorpayKeyId: razorpayKeyId || undefined,
    razorpayKeySecret: razorpayKeySecret || undefined,
    callbackUrl: optional('PAYMENT_CALLBACK_URL') || undefined,
    enabled: Boolean(razorpayKeyId && razorpayKeySecret),
  },
  mandates: {
    spendCapDefault: numberIn('SPEND_CAP_DEFAULT', 500000, 0, Number.MAX_SAFE_INTEGER),
    defaultTtlDays: numberIn('MANDATE_TTL_DAYS', 30, 1, 3650),
  },
  db: {
    url: dbUrl || undefined,
    enabled: Boolean(dbUrl),
  },
  server: {
    publicUrl: optional('PARLEY_PUBLIC_URL') || undefined,
    apiKey: optional('PARLEY_API_KEY') || undefined,
  },
};

export const configIssues = issues;

/** Throws if anything required is missing. Call at the edge of a request, never at import time. */
export function assertConfigured(): ParleyConfig {
  if (issues.length) throw new ConfigError(issues);
  return config;
}

/** Non-throwing view of readiness, used by the dashboard and the discovery document. */
export function configStatus() {
  return {
    ok: issues.length === 0,
    issues,
    paymentsEnabled: config.payments.enabled,
    databaseEnabled: config.db.enabled,
    agentEnabled: Boolean(config.agent.anthropicApiKey || config.agent.geminiApiKey),
  };
}

/** Resolves the public base URL, preferring explicit config over request headers. */
export function publicBaseUrl(req?: Request): string {
  if (config.server.publicUrl) return config.server.publicUrl.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (req) {
    const url = new URL(req.url);
    const host = req.headers.get('x-forwarded-host') ?? url.host;
    const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
    return `${proto}://${host}`;
  }
  return 'http://localhost:3000';
}
