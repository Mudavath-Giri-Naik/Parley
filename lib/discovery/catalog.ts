/**
 * The Discovery Service's single read path into the merchant's catalog.
 *
 * There is no second copy of product data anywhere in this service. Everything the
 * manifest, the feed, the product pages and the JSON-LD say about a product comes
 * through this module, which calls the same endpoints and reuses the same normalizer
 * (`lib/merchantApi`) that Parley's MCP tools call. A price or stock change on the
 * merchant's side is therefore visible here as soon as the short cache below expires.
 *
 * Two deliberate differences from Parley's tool layer:
 *
 *   1. Nothing here writes to the audit log. Crawlers and feed pollers hit these
 *      endpoints continuously; recording every one of those as a buyer-agent action
 *      would bury the record of what an actual customer's agent did.
 *   2. Reads are cached for a few seconds to a few minutes (DISCOVERY_CACHE_TTL_MS).
 *      Parley's `check_stock` remains uncached, and this cache is never consulted
 *      when a purchase is being committed — that path still belongs to Parley.
 */

import {
  callMerchant,
  isRecord,
  merchantMessage,
  merchantUrl,
  normalizeProduct,
  unwrapList,
  unwrapObject,
  type NormalizedProduct,
} from '@/lib/merchantApi';
import { discoveryConfig, parleyConfig } from './config';

/** A normalized product plus the merchant's untouched record behind it. */
export interface CatalogEntry {
  product: NormalizedProduct;
  /**
   * The merchant's own record, so discovery-only fields can be read without
   * widening Parley's canonical product shape.
   */
  raw: Record<string, unknown>;
}

export class CatalogError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

/* ------------------------------------------------------------------ cache --- */

interface CacheSlot<T> {
  value: T;
  storedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __discoveryCatalogCache: Map<string, CacheSlot<unknown>> | undefined;
}

function cache(): Map<string, CacheSlot<unknown>> {
  if (!global.__discoveryCatalogCache) global.__discoveryCatalogCache = new Map();
  return global.__discoveryCatalogCache;
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const ttl = discoveryConfig.cacheTtlMs;
  if (ttl <= 0) return load();

  const slot = cache().get(key) as CacheSlot<T> | undefined;
  if (slot && Date.now() - slot.storedAt < ttl) return slot.value;

  const value = await load();
  cache().set(key, { value, storedAt: Date.now() });
  return value;
}

/** Drops every cached read. Used by the freshness test and after a manual refresh. */
export function invalidateCatalogCache(): void {
  cache().clear();
}

/** How old the cached listing is, in milliseconds, or null when nothing is cached. */
export function catalogCacheAgeMs(): number | null {
  const slot = cache().get('list');
  return slot ? Date.now() - slot.storedAt : null;
}

/* --------------------------------------------------------------- reading --- */

/**
 * Discovery-only fields the merchant may or may not publish. Parley's normalizer
 * covers the fields a purchase needs; these are the ones a search agent wants and a
 * checkout does not.
 */
const EXTRA_ALIASES = {
  category: ['category', 'categories', 'product_type', 'productType', 'collection', 'type'],
  brand: ['brand', 'brand_name', 'brandName', 'vendor', 'manufacturer', 'make'],
  gtin: ['gtin', 'gtin13', 'gtin12', 'gtin14', 'ean', 'upc', 'barcode', 'isbn'],
  sku: ['sku', 'sku_code', 'skuCode', 'article_number', 'mpn'],
  condition: ['condition', 'item_condition', 'itemCondition'],
  status: ['status', 'availability', 'availability_status'],
} as const;

export type ExtraField = keyof typeof EXTRA_ALIASES;

/** Case-insensitive lookup across a field's known aliases. */
export function extra(raw: Record<string, unknown>, field: ExtraField): string | undefined {
  const lowered = new Map(Object.keys(raw).map((key) => [key.toLowerCase(), key]));
  for (const alias of EXTRA_ALIASES[field]) {
    const key = lowered.get(alias.toLowerCase());
    if (key === undefined) continue;
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const parts = value.map((item) => (typeof item === 'object' ? '' : String(item))).filter(Boolean);
      if (parts.length) return parts.join(' > ');
      continue;
    }
    if (typeof value === 'object') continue;
    return String(value);
  }
  return undefined;
}

function toEntry(record: Record<string, unknown>): CatalogEntry {
  return { product: normalizeProduct(record), raw: record };
}

/**
 * The whole catalog, as the merchant's listing endpoint returns it.
 *
 * Sold-out products are asked for explicitly (see DISCOVERY_CATALOG_PARAMS): a
 * shopping agent needs to be told "out of stock", and omitting the product instead
 * makes the agent conclude the merchant does not sell it at all.
 */
export async function listCatalog(): Promise<CatalogEntry[]> {
  return cached('list', async () => {
    const url = merchantUrl(parleyConfig.merchant.searchApi, undefined, {
      ...discoveryConfig.catalogParams,
      limit: discoveryConfig.catalogLimit,
    });
    const response = await callMerchant(url);
    if (!response.ok) {
      throw new CatalogError(
        `The catalog listing failed (HTTP ${response.status}): ${merchantMessage(response.data, response.raw)}`,
        response.status,
      );
    }
    return unwrapList(response.data)
      .map(toEntry)
      .filter((entry) => entry.product.id)
      .slice(0, discoveryConfig.catalogLimit);
  });
}

/** One product by the id Parley's tools also accept. */
export async function lookupCatalogEntry(id: string): Promise<CatalogEntry | null> {
  return cached(`item:${id}`, async () => {
    const url = merchantUrl(parleyConfig.merchant.stockApi, id);
    const response = await callMerchant(url);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new CatalogError(
        `Could not load product "${id}" (HTTP ${response.status}): ${merchantMessage(response.data, response.raw)}`,
        response.status,
      );
    }
    const record = unwrapObject(response.data);
    if (!isRecord(record)) return null;
    const entry = toEntry(record);
    if (!entry.product.id) entry.product.id = id;
    return entry;
  });
}

/**
 * Resolves several ids at once, falling back to the cached listing for any the
 * single-product endpoint does not know. Used by the UCP batch lookup.
 */
export async function lookupCatalogEntries(ids: string[]): Promise<Map<string, CatalogEntry>> {
  const found = new Map<string, CatalogEntry>();
  const settled = await Promise.allSettled(ids.map((id) => lookupCatalogEntry(id)));

  const missing: string[] = [];
  settled.forEach((outcome, index) => {
    const id = ids[index];
    if (outcome.status === 'fulfilled' && outcome.value) found.set(id, outcome.value);
    else missing.push(id);
  });

  if (missing.length) {
    const listing = await listCatalog().catch(() => [] as CatalogEntry[]);
    for (const entry of listing) {
      if (missing.includes(entry.product.id)) found.set(entry.product.id, entry);
    }
  }
  return found;
}

/* ------------------------------------------------------------ derivation --- */

export interface Availability {
  available: boolean;
  status: string;
}

/** Whether a product can be bought right now, as far as the merchant has said. */
export function availability(entry: CatalogEntry): Availability | null {
  const { in_stock: inStock, stock } = entry.product;
  const declared = extra(entry.raw, 'status')?.toLowerCase();

  if (stock !== null) {
    return stock <= 0
      ? { available: false, status: 'out_of_stock' }
      : { available: true, status: 'in_stock' };
  }
  if (inStock === true) return { available: true, status: 'in_stock' };
  if (inStock === false) return { available: false, status: 'out_of_stock' };
  if (declared) {
    if (/discontinued/.test(declared)) return { available: false, status: 'discontinued' };
    if (/pre[_\s-]?order/.test(declared)) return { available: false, status: 'preorder' };
    if (/back[_\s-]?order/.test(declared)) return { available: false, status: 'backorder' };
    if (/sold[_\s-]?out|out[_\s-]?of[_\s-]?stock|unavailable/.test(declared)) {
      return { available: false, status: 'out_of_stock' };
    }
    if (/in[_\s-]?stock|available/.test(declared)) return { available: true, status: 'in_stock' };
  }
  // The merchant publishes no availability signal. Saying nothing is the honest
  // answer; asserting `available: true` here would be a guess an agent acts on.
  return null;
}

/** A URL-safe slug, used for product handles and grouping keys. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * The canonical page a shopper should be sent to.
 *
 * Preference order: the URL the merchant's own catalog publishes, then the template
 * the merchant configured, and only if neither exists, this service's own
 * server-rendered product page.
 */
export function productUrl(entry: CatalogEntry, base: string): string {
  const id = entry.product.id;
  if (entry.product.url) {
    try {
      return new URL(entry.product.url, discoveryConfig.storefrontOrigin ?? base).toString();
    } catch {
      // Fall through to the configured template.
    }
  }
  const template = discoveryConfig.productUrlTemplate;
  if (template) {
    return template.includes('{id}')
      ? template.replaceAll('{id}', encodeURIComponent(id))
      : `${template.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
  }
  return `${base.replace(/\/+$/, '')}/p/${encodeURIComponent(id)}`;
}

/**
 * Groups catalog rows into products with variants.
 *
 * Storefronts commonly store one row per size or colour. UCP and ACP both model that
 * as one product with several variants, and an agent reading a flat list otherwise
 * sees the same shirt four times. Grouping is by title, the only signal a
 * config-driven service can rely on; DISCOVERY_GROUP_VARIANTS=false turns it off.
 */
export interface ProductGroup {
  key: string;
  title: string;
  variants: CatalogEntry[];
}

export function groupCatalog(entries: CatalogEntry[]): ProductGroup[] {
  if (!discoveryConfig.groupVariants) {
    return entries.map((entry) => ({
      key: entry.product.id,
      title: entry.product.name,
      variants: [entry],
    }));
  }

  const groups = new Map<string, ProductGroup>();
  for (const entry of entries) {
    const title = entry.product.name;
    const key = slug(title) || entry.product.id;
    const existing = groups.get(key);
    if (existing) existing.variants.push(entry);
    else groups.set(key, { key, title, variants: [entry] });
  }
  return [...groups.values()];
}

/** Finds the group a single catalog id belongs to, for product-page rendering. */
export function groupContaining(groups: ProductGroup[], id: string): ProductGroup | undefined {
  return groups.find((group) => group.variants.some((entry) => entry.product.id === id));
}
