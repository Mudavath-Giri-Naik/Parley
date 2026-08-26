/**
 * ACP product feed, spec version 2026-04-17.
 *
 * Shapes taken from the published schema bundle, not from memory:
 *   spec/2026-04-17/json-schema/schema.feed.json   (Product, Variant, Price,
 *   Availability, Barcode, Media, Category, VariantOption, Seller, FeedMetadata,
 *   ProductsResponse) in the agentic-commerce-protocol repository.
 *
 * Two details from that schema shape everything below.
 *
 * First, every object in the bundle sets `additionalProperties: false`. A field the
 * schema does not define is not an extension, it is a validation failure — so this
 * module emits the defined fields and nothing else, and drops anything the merchant's
 * catalog has that ACP has no home for.
 *
 * Second, ACP's feed API is a push model: a merchant creates a feed on an AI
 * platform and PATCHes products into it. `GET /feeds/{id}/products` returns the
 * `ProductsResponse` envelope. This service serves that same envelope for pull, built
 * live from the catalog, so a platform can either poll it or a scheduled job can PATCH
 * its contents onward without a second product mapping existing anywhere.
 */

import { currency, discoveryConfig, merchantName } from './config';
import {
  availability,
  extra,
  groupCatalog,
  productUrl,
  type CatalogEntry,
  type ProductGroup,
} from './catalog';

export const ACP_FEED_VERSION = '2026-04-17';

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function price(entry: CatalogEntry): { amount: number; currency: string } | undefined {
  const amount = entry.product.price_minor;
  if (amount === null || amount < 0) return undefined;
  return { amount, currency: entry.product.currency || currency() };
}

function description(text: string | undefined): { plain: string } | undefined {
  const value = (text ?? '').trim();
  // Description requires at least one property, so an empty one must be omitted
  // entirely rather than sent as `{}`.
  return value ? { plain: value } : undefined;
}

function media(entry: CatalogEntry) {
  const url = entry.product.image;
  return url ? [{ type: 'image', url, alt_text: entry.product.name }] : undefined;
}

function categories(entry: CatalogEntry) {
  const value = extra(entry.raw, 'category');
  return value ? [{ value, taxonomy: 'merchant' }] : undefined;
}

function barcodes(entry: CatalogEntry) {
  // GTIN, EAN, UPC and friends, when the merchant's catalog publishes one. Nothing is
  // synthesised: a fabricated GTIN is worse for a shopping agent than no GTIN.
  const value = extra(entry.raw, 'gtin');
  return value ? [{ type: 'GTIN', value }] : undefined;
}

function variantOptions(entry: CatalogEntry) {
  const options: { name: string; value: string }[] = [];
  if (entry.product.size) options.push({ name: 'Size', value: entry.product.size });
  if (entry.product.color) options.push({ name: 'Color', value: entry.product.color });
  return options.length ? options : undefined;
}

function condition(entry: CatalogEntry) {
  const value = extra(entry.raw, 'condition');
  return value ? [value] : undefined;
}

function variantTitle(entry: CatalogEntry): string {
  const parts = [entry.product.color, entry.product.size].filter(Boolean);
  return parts.length ? `${entry.product.name} - ${parts.join(' / ')}` : entry.product.name;
}

/**
 * One ACP feed Variant.
 *
 * `id` carries the merchant's own product id. ACP's feed Variant has no `sku` field,
 * so the id is where a SKU has to live — and it needs to be the same id Parley's
 * purchase tools accept, otherwise an agent that finds the product here cannot buy it.
 *
 * `availability` is always emitted when the merchant publishes stock, including when
 * the answer is no. A sold-out product left out of the feed reads as a product the
 * merchant does not carry.
 */
export function toFeedVariant(entry: CatalogEntry, base: string): Record<string, unknown> {
  const stock = availability(entry);
  return compact({
    id: entry.product.id,
    title: variantTitle(entry),
    description: description(entry.product.description),
    url: productUrl(entry, base),
    barcodes: barcodes(entry),
    price: price(entry),
    availability: stock ?? undefined,
    categories: categories(entry),
    condition: condition(entry),
    variant_options: variantOptions(entry),
    media: media(entry),
    seller: { name: merchantName() },
  });
}

/** One ACP feed Product, grouping variants that share a title. */
export function toFeedProduct(group: ProductGroup, base: string): Record<string, unknown> {
  const first = group.variants[0];
  return compact({
    id: group.key,
    title: group.title,
    description: description(first.product.description),
    url: productUrl(first, base),
    media: media(first),
    variants: group.variants.map((entry) => toFeedVariant(entry, base)),
  });
}

/** The `ProductsResponse` envelope, built live from the catalog. */
export function buildFeed(entries: CatalogEntry[], base: string): { products: Record<string, unknown>[] } {
  return {
    products: groupCatalog(entries)
      .map((group) => toFeedProduct(group, base))
      .filter((product) => (product.variants as unknown[]).length > 0),
  };
}

/**
 * The `FeedMetadata` resource.
 *
 * `id` is derived from the deployment rather than issued by a platform, because this
 * feed is pulled rather than created through `POST /feeds`. `updated_at` is the moment
 * the catalog was last read, which is the only freshness claim this service can make
 * honestly — the merchant's catalog does not publish a change timestamp.
 */
export function buildFeedMetadata(feedId: string, readAt: Date): Record<string, unknown> {
  return compact({
    id: feedId,
    target_country: discoveryConfig.feedTargetCountry,
    updated_at: readAt.toISOString(),
  });
}
