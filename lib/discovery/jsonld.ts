/**
 * schema.org Product markup, generated from the catalog.
 *
 * This is what a general web crawler reads — Google, Bing, and the AI crawlers that
 * follow the same conventions — as opposed to UCP and ACP, which are read by agents
 * that already know they are shopping. It is the oldest and still the widest-reach
 * channel of the three, which is why it is generated from the same catalog read as
 * the other two rather than maintained by hand per product.
 *
 * Property names follow schema.org's Product and Offer vocabulary. Availability uses
 * the schema.org enumeration URLs rather than the bare token, because that is the
 * form Google's structured-data parsing documents and the form the schema.org
 * validator accepts without a warning.
 */

import { merchantName } from './config';
import { availability, extra, productUrl, type CatalogEntry, type ProductGroup } from './catalog';

const SCHEMA = 'https://schema.org';

/** schema.org's ItemAvailability enumeration, keyed by the status this service derives. */
const AVAILABILITY_URLS: Record<string, string> = {
  in_stock: `${SCHEMA}/InStock`,
  out_of_stock: `${SCHEMA}/OutOfStock`,
  backorder: `${SCHEMA}/BackOrder`,
  preorder: `${SCHEMA}/PreOrder`,
  discontinued: `${SCHEMA}/Discontinued`,
};

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Price as schema.org wants it: major units, decimal string, no currency symbol. */
function priceString(minor: number): string {
  return (minor / 100).toFixed(2);
}

function offer(entry: CatalogEntry, base: string): Record<string, unknown> | undefined {
  const minor = entry.product.price_minor;
  if (minor === null) return undefined;
  const stock = availability(entry);
  return compact({
    '@type': 'Offer',
    url: productUrl(entry, base),
    price: priceString(minor),
    priceCurrency: entry.product.currency,
    availability: stock ? AVAILABILITY_URLS[stock.status] : undefined,
    itemCondition: `${SCHEMA}/NewCondition`,
    sku: extra(entry.raw, 'sku') ?? entry.product.id,
    seller: { '@type': 'Organization', name: merchantName() },
  });
}

/**
 * Product markup for a single catalog row.
 *
 * `brand` falls back to the merchant's own configured name, which is accurate for a
 * direct-to-consumer store and is the only brand a config-driven service can know
 * when the catalog does not publish one.
 */
export function productJsonLd(entry: CatalogEntry, base: string): Record<string, unknown> {
  const single = offer(entry, base);
  return compact({
    '@context': SCHEMA,
    '@type': 'Product',
    '@id': `${productUrl(entry, base)}#product`,
    name: entry.product.name,
    description: entry.product.description || entry.product.name,
    image: entry.product.image,
    sku: extra(entry.raw, 'sku') ?? entry.product.id,
    gtin: extra(entry.raw, 'gtin'),
    brand: { '@type': 'Brand', name: extra(entry.raw, 'brand') ?? merchantName() },
    category: extra(entry.raw, 'category'),
    color: entry.product.color,
    size: entry.product.size,
    offers: single,
  });
}

/**
 * Product markup for a group of variants.
 *
 * schema.org models "one product, several buyable variants" as a Product carrying an
 * AggregateOffer, with each variant's own Offer inside it. That is what lets a crawler
 * report an accurate price range and, crucially, still see the sold-out variant as a
 * variant that exists and is unavailable.
 */
export function groupJsonLd(group: ProductGroup, base: string): Record<string, unknown> {
  const offers = group.variants
    .map((entry) => offer(entry, base))
    .filter((value): value is Record<string, unknown> => value !== undefined);

  if (offers.length <= 1) return productJsonLd(group.variants[0], base);

  const prices = group.variants
    .map((entry) => entry.product.price_minor)
    .filter((value): value is number => value !== null);

  const first = group.variants[0];
  return compact({
    '@context': SCHEMA,
    '@type': 'Product',
    '@id': `${productUrl(first, base)}#product`,
    name: group.title,
    description: first.product.description || group.title,
    image: first.product.image,
    brand: { '@type': 'Brand', name: extra(first.raw, 'brand') ?? merchantName() },
    category: extra(first.raw, 'category'),
    offers: {
      '@type': 'AggregateOffer',
      offerCount: offers.length,
      lowPrice: priceString(Math.min(...prices)),
      highPrice: priceString(Math.max(...prices)),
      priceCurrency: first.product.currency,
      offers,
    },
  });
}

/** The `<script type="application/ld+json">` block for a page, already escaped. */
export function jsonLdScript(payload: Record<string, unknown>): string {
  // `</script>` inside JSON would end the block early; escaping the slash is the
  // standard, spec-safe way to prevent that without altering the parsed value.
  return JSON.stringify(payload).replace(/</g, '\\u003c');
}
