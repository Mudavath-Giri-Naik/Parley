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
    orderSuccessFields: string[];
    orderErrorFields: string[];
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

/** Comma-separated list of field names, trimmed and de-duplicated. */
function parseFieldList(key: string, fallback: string): string[] {
  const raw = optional(key, fallback);
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) {
    issues.push(`${key} must list at least one field name, or be left unset.`);
    return fallback.split(',');
  }
  return [...new Set(names)];
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
    // Plenty of APIs answer "no" with HTTP 200 and a flag in the body. These name
    // the fields that carry that answer, because the convention varies by merchant.
    orderSuccessFields: parseFieldList(
      'ORDER_SUCCESS_FIELDS',
      'ok,success,succeeded,is_success,isSuccess',
    ),
    orderErrorFields: parseFieldList(
      'ORDER_ERROR_FIELDS',
      'error,errors,error_code,errorCode,error_message,errorMessage,failure,fault',
    ),
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

/** A proxy may forward several values; the first one is the client-facing one. */
function firstValue(header: string | null): string | undefined {
  const value = header?.split(',')[0]?.trim();
  return value || undefined;
}

/**
 * Resolves the public base URL of this deployment.
 *
 * Order matters. An explicit PARLEY_PUBLIC_URL is the merchant's stated intent and
 * always wins. Otherwise the live request wins, because it is the only source that
 * describes the address actually being used right now: on a Vercel preview,
 * VERCEL_PROJECT_PRODUCTION_URL names the production domain, which is not the host
 * the visitor is looking at. The VERCEL_* values remain the fallback for contexts
 * that have no request at all.
 *
 * Accepts a Request (route handlers) or Headers (server components).
 */
export function publicBaseUrl(source?: Request | Headers): string {
  if (config.server.publicUrl) return config.server.publicUrl.replace(/\/+$/, '');

  if (source) {
    const headers = source instanceof Headers ? source : source.headers;
    const requestUrl = source instanceof Headers ? undefined : new URL(source.url);

    const host =
      firstValue(headers.get('x-forwarded-host')) ??
      firstValue(headers.get('host')) ??
      requestUrl?.host;

    if (host) {
      const proto =
        firstValue(headers.get('x-forwarded-proto')) ??
        requestUrl?.protocol.replace(':', '') ??
        (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host) ? 'http' : 'https');
      return `${proto}://${host}`;
    }
  }

  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

/**
 * Identifies this deployment among all the others sharing a database.
 *
 * Derived from the deployment's own hostname, so a merchant who deploys their own
 * copy gets a unique identifier with nothing to configure. MERCHANT_ID overrides it,
 * which matters when a merchant moves to a custom domain and wants to keep the
 * history that accumulated under the old hostname.
 *
 * Deliberately does not depend on a request: audit writes happen where there is no
 * request to read, and this value must never differ between two writes from the
 * same deployment.
 */
export function merchantId(): string {
  const explicit = optional('MERCHANT_ID');
  if (explicit) return explicit.slice(0, 200);

  try {
    return new URL(publicBaseUrl()).host.toLowerCase().slice(0, 200);
  } catch {
    return 'localhost';
  }
}
