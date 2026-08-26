/**
 * UCP — the Universal Commerce Protocol business profile and shopping payloads.
 *
 * Every shape here was taken from the published 2026-08-25 schemas at ucp.dev, not
 * from memory:
 *
 *   profile   https://ucp.dev/2026-08-25/schemas/profile.json
 *   metadata  https://ucp.dev/2026-08-25/schemas/ucp.json
 *   product   https://ucp.dev/2026-08-25/schemas/shopping/types/product.json
 *   variant   https://ucp.dev/2026-08-25/schemas/shopping/types/variant.json
 *   search    https://ucp.dev/2026-08-25/schemas/shopping/catalog_search.json
 *   lookup    https://ucp.dev/2026-08-25/schemas/shopping/catalog_lookup.json
 *   cart      https://ucp.dev/2026-08-25/schemas/shopping/cart.json
 *
 * One rule governs what this file is allowed to declare: the profile advertises only
 * capabilities this deployment actually serves. Catalog search, catalog lookup and
 * cart are implemented here against the merchant's live catalog. Checkout is not —
 * Parley already owns that, over MCP, and re-implementing it as a second UCP REST
 * checkout would be a second checkout with a second set of limits to keep in step.
 * The handoff to Parley is therefore declared under this deployment's own
 * reverse-domain namespace rather than as `dev.ucp.shopping.checkout`, so a UCP
 * platform is routed into the flow that works instead of being told to call
 * endpoints that do not exist.
 */

import { LATEST_PROTOCOL_VERSION, activeTools } from '@/lib/mcp/server';
import type { NormalizedProduct } from '@/lib/merchantApi';
import { currency, discoveryConfig, merchantName, parleyConfig } from './config';
import {
  availability,
  extra,
  groupCatalog,
  productUrl,
  slug,
  type CatalogEntry,
  type ProductGroup,
} from './catalog';

/** The UCP release this service speaks. Date-based, per UCP's versioning policy. */
export const UCP_VERSION = '2026-08-25';

const UCP_BASE = `https://ucp.dev/${UCP_VERSION}`;

/* ------------------------------------------------------------ namespacing --- */

/** UCP's reverse-domain name grammar, from common/types/reverse_domain_name.json. */
const REVERSE_DOMAIN =
  /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9_])?)+$/;

/**
 * This deployment's own reverse-domain namespace, or null when it has no domain.
 *
 * UCP binds a name's authority to the domain it reverses, and requires an entity's
 * `schema` URL to originate from that domain. Deriving the namespace from the
 * deployment's own hostname — the same hostname Parley already derives `merchant_id`
 * from — means the schemas this service serves for its own capabilities are hosted on
 * exactly the domain that governs their names, with nothing to configure.
 *
 * A deployment reached by IP address has no such domain. Reversing `127.0.0.1` gives
 * `1.0.0.127`, which is not a legal reverse-domain name — the first segment is a
 * reversed TLD and must begin with a letter — and there is no rearrangement of an IP
 * literal that a platform could bind authority to anyway. So this returns null and the
 * caller declares no vendor capability at all, rather than emitting a name that makes
 * the whole profile fail validation. The routing that capability carries is published
 * on the MCP service binding regardless, so nothing is lost but the extra declaration.
 */
export function namespaceFor(base: string): string | null {
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return null;
  }
  // An IPv6 literal arrives bracketed; either family is a non-domain host.
  if (host.startsWith('[') || /^\d+(\.\d+)*$/.test(host)) return null;

  const labels = host.split('.').filter(Boolean).reverse();
  // A single-label host (localhost, a container name) still needs two segments to be
  // a reverse-domain name. Appending keeps the first segment equal to the host, which
  // is what makes authority binding resolve.
  if (labels.length < 2) labels.push('local');

  const cleaned = labels.map((label) => label.replace(/[^a-z0-9_-]/g, '') || 'x');
  // The first segment is the reversed TLD: letters, digits and interior hyphens only.
  cleaned[0] = cleaned[0].replace(/_/g, '-').replace(/^-+|-+$/g, '');

  const name = cleaned.join('.');
  return REVERSE_DOMAIN.test(name) ? name : null;
}

/* ---------------------------------------------------------------- profile --- */

interface UcpEntity {
  version: string;
  spec?: string;
  schema?: string;
  id?: string;
  config?: Record<string, unknown>;
}

interface UcpService extends UcpEntity {
  transport: 'rest' | 'mcp' | 'a2a' | 'embedded';
  endpoint?: string;
}

export interface UcpBusinessProfile {
  ucp: {
    version: string;
    services: Record<string, UcpService[]>;
    capabilities: Record<string, (UcpEntity & { extends?: string | string[] })[]>;
    payment_handlers: Record<string, UcpEntity[]>;
  };
}

/**
 * Builds the document served at `/.well-known/ucp`.
 *
 * Generated per request from configuration and from Parley's own tool registry, so
 * it cannot drift out of step with what the deployment actually offers: turn the
 * seller agent off and the negotiation tool disappears from here too.
 */
export function buildProfile(base: string): UcpBusinessProfile {
  const ns = namespaceFor(base);
  const restEndpoint = `${base}/api/discovery/ucp`;
  const mcpEndpoint = `${base}/api/mcp`;

  /**
   * How a purchase is actually completed here. Published on the MCP service binding
   * so it reaches a platform whether or not the vendor capability below can be
   * declared — a deployment reached by IP has no domain to name a capability under.
   */
  const checkoutRouting = {
    quote: 'get_product_details',
    confirm_availability: 'check_stock',
    negotiate: 'negotiate_with_seller',
    place_order: 'create_order_and_pay',
    order_status: 'check_order_status',
  };

  const services: Record<string, UcpService[]> = {
    'dev.ucp.shopping': [
      {
        version: UCP_VERSION,
        spec: `${UCP_BASE}/specification/overview/`,
        transport: 'rest',
        endpoint: restEndpoint,
        schema: `${UCP_BASE}/services/shopping/rest.openapi.json`,
      },
      {
        // Parley's MCP server, advertised so an MCP-native agent finds the
        // transaction path without a second integration. `schema` is deliberately
        // omitted rather than pointed at UCP's OpenRPC document: Parley's tool names
        // are its own, and claiming otherwise would send an agent looking for methods
        // that are not there. UCP's business service schema makes `schema` optional
        // for exactly this case.
        version: UCP_VERSION,
        spec: `${base}/.well-known/agent-commerce.json`,
        transport: 'mcp',
        endpoint: mcpEndpoint,
        config: {
          protocol: 'modelcontextprotocol',
          protocol_version: LATEST_PROTOCOL_VERSION,
          transport: 'streamable-http',
          authentication: parleyConfig.server.apiKey ? 'bearer' : 'none',
          tools: activeTools().map((tool) => tool.name),
          checkout: {
            ...checkoutRouting,
            notice:
              'Checkout is completed by calling these MCP tools, not by a UCP REST checkout ' +
              'session. This business does not implement dev.ucp.shopping.checkout.',
          },
        },
      },
    ],
  };

  const capabilities: UcpBusinessProfile['ucp']['capabilities'] = {
    // Discovery. Both halves of UCP's catalog capability are served by this
    // deployment, reading the merchant's live catalog on every call.
    'dev.ucp.shopping.catalog.search': [
      {
        version: UCP_VERSION,
        spec: `${UCP_BASE}/specification/shopping/catalog/search/`,
        schema: `${UCP_BASE}/schemas/shopping/catalog_search.json`,
      },
    ],
    'dev.ucp.shopping.catalog.lookup': [
      {
        version: UCP_VERSION,
        spec: `${UCP_BASE}/specification/shopping/catalog/lookup/`,
        schema: `${UCP_BASE}/schemas/shopping/catalog_lookup.json`,
      },
    ],
    // Cart. Priced live from the catalog on every call; the cart id carries its own
    // contents, so nothing about a cart is stored and nothing about it can go stale.
    'dev.ucp.shopping.cart': [
      {
        version: UCP_VERSION,
        spec: `${UCP_BASE}/specification/shopping/cart/`,
        schema: `${UCP_BASE}/schemas/shopping/cart.json`,
      },
    ],
  };

  // Checkout, as this deployment actually performs it: a handoff into Parley's
  // existing negotiate-and-buy flow over MCP. Named under this deployment's own
  // authority because it is not UCP's checkout contract, and the schema is served from
  // that same authority, as UCP's authority binding requires. Omitted entirely when
  // there is no domain to claim authority under — see namespaceFor.
  if (ns) {
    capabilities[`${ns}.checkout_handoff`] = [
      {
        version: UCP_VERSION,
        spec: `${base}/.well-known/agent-commerce.json`,
        // Deliberately a root capability rather than an extension of cart: it does
        // not augment cart's schema, and a platform that skips the cart should still
        // be able to negotiate it.
        schema: `${base}/api/discovery/ucp/schemas/checkout_handoff.json`,
        config: {
          transport: 'mcp',
          endpoint: mcpEndpoint,
          protocol_version: LATEST_PROTOCOL_VERSION,
          tools: checkoutRouting,
          spend_mandate: {
            supported: parleyConfig.db.enabled,
            tools: { check: 'check_mandate', create: 'create_mandate' },
            note:
              'A customer-authorized spend cap enforced in Postgres. Not an AP2 verifiable ' +
              'credential; see the deployment notice for the difference.',
          },
          notice:
            'Checkout is completed by calling the MCP tools above, not by a UCP REST ' +
            'checkout session. This capability exists so a UCP platform is routed into the ' +
            'transaction path this deployment actually implements.',
        },
      },
    ];
  }

  const paymentHandlers: Record<string, UcpEntity[]> = parleyConfig.payments.enabled
    ? {
        // A payment-handler declaration carries no schema URL, so no authority
        // binding applies to it; the name identifies the rail, and `config` says how
        // this deployment drives it.
        'com.razorpay.payment_link': [
          {
            id: 'razorpay_payment_link',
            version: UCP_VERSION,
            spec: 'https://razorpay.com/docs/payments/payment-links/',
            available_instruments: [{ type: 'card' }, { type: 'bank_transfer' }],
            config: {
              mode: 'hosted_payment_link',
              currency: currency(),
              acquisition:
                'The business creates the payment link during create_order_and_pay and returns ' +
                'its URL. The platform never handles a credential, so no tokenization step runs ' +
                'on the platform side.',
              settlement: 'razorpay',
            },
          } as UcpEntity,
        ],
      }
    : {};

  return {
    ucp: {
      version: UCP_VERSION,
      services,
      // Both registries MUST be present even when empty, per the profile spec.
      capabilities,
      payment_handlers: paymentHandlers,
    },
  };
}

/**
 * The schema for the checkout-handoff capability this deployment declares.
 *
 * Served from this deployment's own origin because UCP requires an entity's schema
 * URL to originate from the domain its reverse-domain name reverses.
 */
export function checkoutHandoffSchema(base: string): Record<string, unknown> | null {
  const ns = namespaceFor(base);
  // No domain, no capability, and therefore no schema to serve for one.
  if (!ns) return null;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${base}/api/discovery/ucp/schemas/checkout_handoff.json`,
    name: `${ns}.checkout_handoff`,
    title: 'Checkout Handoff',
    version: UCP_VERSION,
    description:
      'Routes a UCP platform from catalog and cart into this business\'s existing MCP checkout ' +
      'flow. The business does not implement dev.ucp.shopping.checkout; a platform completes the ' +
      'purchase by calling the MCP tools named in this capability\'s config.',
    type: 'object',
    required: ['transport', 'endpoint', 'tools'],
    properties: {
      transport: { const: 'mcp', description: 'The handoff is an MCP session, not a REST call.' },
      endpoint: { type: 'string', format: 'uri', description: 'MCP endpoint to connect to.' },
      protocol_version: { type: 'string', description: 'MCP protocol version this endpoint speaks.' },
      tools: {
        type: 'object',
        description: 'Maps each step of a purchase to the MCP tool that performs it.',
        required: ['place_order'],
        properties: {
          quote: { type: 'string' },
          confirm_availability: { type: 'string' },
          negotiate: { type: 'string' },
          place_order: { type: 'string' },
          order_status: { type: 'string' },
        },
      },
      spend_mandate: {
        type: 'object',
        description: 'Whether a standing, customer-authorized spend cap can complete a purchase without a human in the loop.',
        properties: {
          supported: { type: 'boolean' },
          tools: { type: 'object' },
          note: { type: 'string' },
        },
      },
      notice: { type: 'string' },
    },
    additionalProperties: true,
  };
}

/* ------------------------------------------------------ catalog payloads --- */

interface UcpPrice {
  amount: number;
  currency: string;
}

/**
 * A price the merchant did publish, or null. UCP's Amount is a non-negative integer
 * in minor units, which is exactly what Parley normalizes to.
 */
function price(product: NormalizedProduct): UcpPrice | null {
  if (product.price_minor === null || product.price_minor < 0) return null;
  return { amount: product.price_minor, currency: product.currency || currency() };
}

/** Description is required on both Product and Variant, and needs at least one format. */
function description(text: string | undefined, fallback: string): { plain: string } {
  const value = (text ?? '').trim();
  return { plain: value || fallback };
}

function categories(entry: CatalogEntry) {
  const value = extra(entry.raw, 'category');
  return value ? [{ value, taxonomy: 'merchant' }] : undefined;
}

function media(entry: CatalogEntry) {
  const image = entry.product.image;
  if (!image) return undefined;
  return [{ type: 'image', url: image, alt_text: entry.product.name }];
}

function selectedOptions(entry: CatalogEntry) {
  const options: { name: string; label: string }[] = [];
  if (entry.product.size) options.push({ name: 'Size', label: entry.product.size });
  if (entry.product.color) options.push({ name: 'Color', label: entry.product.color });
  return options.length ? options : undefined;
}

function variantTitle(entry: CatalogEntry): string {
  const parts = [entry.product.color, entry.product.size].filter(Boolean);
  return parts.length ? parts.join(' / ') : entry.product.name;
}

function barcodes(entry: CatalogEntry) {
  const gtin = extra(entry.raw, 'gtin');
  return gtin ? [{ type: 'GTIN', value: gtin }] : undefined;
}

/** Drops keys whose value is undefined, so optional fields are absent rather than null. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * One UCP Variant.
 *
 * `id` is the merchant's own product id — the same id Parley's `get_product_details`
 * and `create_order_and_pay` take — because UCP says variant.id is what a checkout
 * carries, and an agent must be able to move from this document into a purchase
 * without a second lookup.
 */
export function toUcpVariant(entry: CatalogEntry, base: string): Record<string, unknown> {
  const amount = price(entry.product);
  const stock = availability(entry);
  return compact({
    id: entry.product.id,
    sku: extra(entry.raw, 'sku') ?? entry.product.id,
    barcodes: barcodes(entry),
    title: variantTitle(entry),
    description: description(entry.product.description, entry.product.name),
    url: productUrl(entry, base),
    categories: categories(entry),
    // A variant with no published price is still worth listing; UCP marks price
    // optional on a variant precisely so a catalog can say "ask us".
    price: amount ?? undefined,
    availability: stock ?? undefined,
    options: selectedOptions(entry),
    media: media(entry),
    seller: { name: merchantName() },
  });
}

/** One UCP Product, grouping the variants that share a title. */
export function toUcpProduct(group: ProductGroup, base: string): Record<string, unknown> {
  const variants = group.variants.map((entry) => toUcpVariant(entry, base));
  const amounts = group.variants
    .map((entry) => price(entry.product))
    .filter((value): value is UcpPrice => value !== null);

  const min = amounts.length ? amounts.reduce((a, b) => (a.amount <= b.amount ? a : b)) : null;
  const max = amounts.length ? amounts.reduce((a, b) => (a.amount >= b.amount ? a : b)) : null;

  const first = group.variants[0];
  const sizes = [...new Set(group.variants.map((e) => e.product.size).filter(Boolean))] as string[];
  const colors = [...new Set(group.variants.map((e) => e.product.color).filter(Boolean))] as string[];

  const options: { name: string; values: { label: string }[] }[] = [];
  if (sizes.length) options.push({ name: 'Size', values: sizes.map((label) => ({ label })) });
  if (colors.length) options.push({ name: 'Color', values: colors.map((label) => ({ label })) });

  return compact({
    id: group.key,
    handle: slug(group.title) || undefined,
    title: group.title,
    description: description(first.product.description, group.title),
    url: productUrl(first, base),
    categories: categories(first),
    // price_range is required. When not one variant publishes a price there is no
    // honest range to state, so the product is filtered out upstream instead.
    price_range: min && max ? { min, max } : undefined,
    media: media(first),
    options: options.length ? options : undefined,
    variants,
  });
}

/** Products with no price at all cannot satisfy UCP's required `price_range`. */
export function toUcpProducts(entries: CatalogEntry[], base: string): Record<string, unknown>[] {
  return groupCatalog(entries)
    .map((group) => toUcpProduct(group, base))
    .filter((product) => product.price_range !== undefined && (product.variants as unknown[]).length > 0);
}

/* --------------------------------------------------------------- envelope --- */

/** The `ucp` member every catalog and cart response carries, confirming what is active. */
export function responseEnvelope(names: string[]): Record<string, unknown> {
  return {
    version: UCP_VERSION,
    capabilities: Object.fromEntries(names.map((name) => [name, [{ version: UCP_VERSION }]])),
  };
}

/** Cache lifetime advertised on discovery responses, matching the catalog cache. */
export function cacheControl(): string {
  const seconds = Math.max(0, Math.floor(discoveryConfig.cacheTtlMs / 1000));
  return seconds > 0 ? `public, max-age=${seconds}` : 'no-store';
}
