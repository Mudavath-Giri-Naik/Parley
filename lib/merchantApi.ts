import { config, type CanonicalProductField } from './config';
import { parsePrice, toMinorUnits } from './money';

/**
 * The seam between Parley and whatever the merchant already runs.
 *
 * Parley makes no assumptions about response envelopes or field names: FIELD_MAP
 * renames fields, and the unwrapping below copes with the handful of shapes real
 * storefront APIs actually return.
 */

export class MerchantApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'MerchantApiError';
  }
}

export interface NormalizedProduct {
  id: string;
  name: string;
  price_minor: number | null;
  price_display: string | null;
  currency: string;
  in_stock: boolean | null;
  stock: number | null;
  description?: string;
  image?: string;
  url?: string;
  size?: string;
  color?: string;
}

const REQUEST_TIMEOUT_MS = Number(process.env.MERCHANT_API_TIMEOUT_MS ?? 15_000);

function merchantHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'Parley/1.0 (+agent-commerce)',
  };
  if (config.merchant.apiKey) {
    const header = config.merchant.apiKeyHeader;
    headers[header] =
      header.toLowerCase() === 'authorization' && !/^bearer\s/i.test(config.merchant.apiKey)
        ? `Bearer ${config.merchant.apiKey}`
        : config.merchant.apiKey;
  }
  return headers;
}

/**
 * Builds a merchant URL. If the configured URL contains an `{id}` placeholder it is
 * substituted; otherwise the id is appended as a path segment. This lets a merchant
 * express `/api/products/{id}` or `/api/products` without Parley guessing.
 */
export function merchantUrl(base: string, id?: string, params?: Record<string, unknown>): string {
  let url = base;
  if (id !== undefined) {
    const encoded = encodeURIComponent(id);
    url = url.includes('{id}') ? url.replaceAll('{id}', encoded) : `${url}/${encoded}`;
  }
  const target = new URL(url);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

export interface MerchantResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  raw: string;
}

export async function callMerchant<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<MerchantResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
      headers: { ...merchantHeaders(), ...(init.headers as Record<string, string> | undefined) },
    });
    const raw = await response.text();
    let data: unknown = raw;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        // Leave it as text; callers decide whether that is fatal.
      }
    }
    return { ok: response.ok, status: response.status, data: data as T, raw };
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError'
      ? `The merchant API did not respond within ${REQUEST_TIMEOUT_MS}ms.`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new MerchantApiError(`Could not reach the merchant API at ${url}: ${reason}`, 0, null);
  } finally {
    clearTimeout(timer);
  }
}

const LIST_KEYS = ['products', 'items', 'data', 'results', 'records', 'rows'];
const OBJECT_KEYS = ['product', 'item', 'data', 'result', 'order'];

/** Digs a list of records out of the common response envelopes. */
export function unwrapList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of LIST_KEYS) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
    if (isRecord(value)) {
      for (const nested of LIST_KEYS) {
        if (Array.isArray(value[nested])) {
          return (value[nested] as unknown[]).filter(isRecord);
        }
      }
    }
  }
  return [];
}

/** Digs a single record out of the common response envelopes. */
export function unwrapObject(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  for (const key of OBJECT_KEYS) {
    const value = payload[key];
    if (isRecord(value)) return value;
  }
  const list = unwrapList(payload);
  if (list.length === 1) return list[0];
  return payload;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sensible aliases tried when FIELD_MAP does not name a field explicitly. */
const FIELD_ALIASES: Record<CanonicalProductField, string[]> = {
  id: ['id', 'product_id', 'productId', 'sku', 'slug', 'handle', '_id', 'uuid'],
  name: ['name', 'title', 'product_name', 'productName', 'label'],
  price: ['price', 'cost', 'amount', 'price_inr', 'unit_price', 'unitPrice', 'mrp', 'sale_price'],
  stock: ['stock', 'qty', 'quantity', 'inventory', 'stock_count', 'stockCount', 'available_qty', 'units'],
  currency: ['currency', 'currency_code', 'currencyCode'],
  description: ['description', 'desc', 'details', 'summary', 'body'],
  image: ['image', 'image_url', 'imageUrl', 'thumbnail', 'img', 'photo'],
  url: ['url', 'link', 'permalink', 'product_url', 'productUrl'],
  size: ['size', 'sizes', 'variant_size'],
  color: ['color', 'colour', 'variant_color'],
};

function pick(record: Record<string, unknown>, field: CanonicalProductField): unknown {
  const mapped = config.merchant.fieldMap[field];
  const candidates = mapped ? [mapped, ...FIELD_ALIASES[field]] : FIELD_ALIASES[field];
  for (const key of candidates) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  // Case-insensitive fallback so `Title` matches `title`.
  const lowered = new Map(Object.keys(record).map((k) => [k.toLowerCase(), k]));
  for (const key of candidates) {
    const actual = lowered.get(key.toLowerCase());
    if (actual && record[actual] !== undefined && record[actual] !== null) return record[actual];
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(asString).filter(Boolean);
    return parts.length ? parts.join(', ') : undefined;
  }
  return undefined;
}

/** Reads stock from a number, a boolean, or a string such as "in stock". */
function readStock(value: unknown): { stock: number | null; inStock: boolean | null } {
  if (value === undefined) return { stock: null, inStock: null };
  if (typeof value === 'number') return { stock: value, inStock: value > 0 };
  if (typeof value === 'boolean') return { stock: null, inStock: value };
  if (typeof value === 'string') {
    const numeric = Number(value.replace(/[^0-9.-]/g, ''));
    if (value.trim() !== '' && Number.isFinite(numeric) && /\d/.test(value)) {
      return { stock: numeric, inStock: numeric > 0 };
    }
    if (config.merchant.outOfStockPattern.test(value)) return { stock: null, inStock: false };
    if (/in[_\s-]?stock|available/i.test(value)) return { stock: null, inStock: true };
  }
  return { stock: null, inStock: null };
}

/**
 * Turns one merchant record into the single product shape Parley returns to buyer
 * agents, regardless of the merchant's own field names.
 */
export function normalizeProduct(record: Record<string, unknown>): NormalizedProduct {
  const rawPrice = parsePrice(pick(record, 'price'));
  const priceMinor = rawPrice === null ? null : toMinorUnits(rawPrice);
  const currency = asString(pick(record, 'currency')) ?? config.merchant.currency;

  let { stock, inStock } = readStock(pick(record, 'stock'));
  if (inStock === null) {
    const flag = record.in_stock ?? record.inStock ?? record.available ?? record.is_available;
    if (typeof flag === 'boolean') inStock = flag;
  }

  const id = asString(pick(record, 'id'));
  const name = asString(pick(record, 'name'));

  return {
    id: id ?? '',
    name: name ?? 'Unnamed product',
    price_minor: priceMinor,
    price_display:
      priceMinor === null ? null : `${currency} ${(priceMinor / 100).toFixed(2)}`,
    currency,
    in_stock: inStock,
    stock,
    description: asString(pick(record, 'description')),
    image: asString(pick(record, 'image')),
    url: asString(pick(record, 'url')),
    size: asString(pick(record, 'size')),
    color: asString(pick(record, 'color')),
  };
}

/** True when a merchant response looks like an out-of-stock refusal rather than an outage. */
export function looksOutOfStock(status: number, payload: unknown, raw: string): boolean {
  if (status === 409 || status === 410) return true;
  if (config.merchant.outOfStockPattern.test(raw)) return true;
  if (isRecord(payload)) {
    const flags = [payload.in_stock, payload.inStock, payload.available, payload.is_available];
    if (flags.some((flag) => flag === false)) return true;
    const { inStock } = readStock(payload.stock ?? payload.qty ?? payload.quantity);
    if (inStock === false) return true;
  }
  return false;
}

/** Pulls a human-readable message out of an error payload. */
export function merchantMessage(payload: unknown, raw: string): string {
  if (isRecord(payload)) {
    for (const key of ['message', 'error', 'reason', 'detail', 'description']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (isRecord(value) && typeof value.message === 'string') return value.message;
    }
  }
  return raw.slice(0, 300) || 'No message returned.';
}
