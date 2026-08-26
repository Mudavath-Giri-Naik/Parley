/**
 * UCP cart, priced live and stored nowhere.
 *
 * A cart id here is not a database key — it is the cart's own contents, encoded. Two
 * consequences follow, and both are the point:
 *
 *   - Nothing about a cart can go stale, because there is nothing to go stale. Every
 *     read re-prices the lines against the merchant's live catalog, so a price change
 *     or a sell-out shows up on the very next call rather than whenever a stored copy
 *     happens to be refreshed.
 *   - No cart state is written to the database Parley shares across merchants.
 *
 * The id is signed when a signing secret is configured, so a platform cannot mint a
 * cart with a price of its own choosing. Without a secret the contents are still only
 * ids and quantities — every amount is recomputed from the catalog regardless — so an
 * unsigned deployment is not mispriced, only unauthenticated.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { currency, parleyConfig } from './config';
import { availability, lookupCatalogEntries, type CatalogEntry } from './catalog';
import { json } from './http';
import { responseEnvelope } from './ucp';

export interface CartLineRequest {
  id: string;
  quantity: number;
}

export class CartError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'CartError';
  }
}

const MAX_LINES = 50;
const MAX_QUANTITY = 9_999;

/* --------------------------------------------------------------- cart ids --- */

function secret(): string | undefined {
  // Reuses whichever secret the deployment already has. No new configuration, and
  // no secret value ever leaves this process.
  return (
    process.env.DISCOVERY_CART_SECRET?.trim() ||
    parleyConfig.server.apiKey ||
    parleyConfig.payments.razorpayKeySecret ||
    undefined
  );
}

function sign(payload: string): string {
  const key = secret();
  if (!key) return '';
  return createHmac('sha256', key).update(payload).digest('base64url').slice(0, 24);
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Encodes lines into an opaque, self-describing cart id. */
export function encodeCartId(lines: CartLineRequest[]): string {
  const payload = base64url(JSON.stringify(lines.map((line) => [line.id, line.quantity])));
  const signature = sign(payload);
  return signature ? `cart_${payload}.${signature}` : `cart_${payload}`;
}

/** Decodes a cart id, rejecting one that was tampered with. */
export function decodeCartId(id: string): CartLineRequest[] {
  if (!id.startsWith('cart_')) throw new CartError(`No cart with id "${id}".`, 'cart_not_found');
  const body = id.slice('cart_'.length);
  const [payload, signature = ''] = body.split('.');

  const expected = sign(payload);
  if (expected) {
    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new CartError('This cart id does not verify against this deployment.', 'cart_invalid');
    }
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new CartError(`No cart with id "${id}".`, 'cart_not_found');
  }
  if (!Array.isArray(decoded)) throw new CartError(`No cart with id "${id}".`, 'cart_not_found');

  return decoded.map((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      throw new CartError(`No cart with id "${id}".`, 'cart_not_found');
    }
    return { id: entry[0], quantity: Number(entry[1]) || 1 };
  });
}

/* -------------------------------------------------------------- requests --- */

/** Validates the `line_items` a platform sent, per UCP's cart request schema. */
export function parseLineItems(body: unknown): CartLineRequest[] {
  const raw = (body as { line_items?: unknown })?.line_items;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CartError('line_items must be a non-empty array.', 'invalid_request');
  }
  if (raw.length > MAX_LINES) {
    throw new CartError(`A cart may hold at most ${MAX_LINES} lines.`, 'invalid_request');
  }

  const lines: CartLineRequest[] = [];
  for (const item of raw) {
    const record = item as { item?: { id?: unknown }; quantity?: unknown };
    const id = record?.item?.id;
    if (typeof id !== 'string' || !id.trim()) {
      throw new CartError('Each line item needs item.id.', 'invalid_request');
    }
    const quantity = Math.trunc(Number(record.quantity));
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw new CartError(`Line "${id}" needs an integer quantity of at least 1.`, 'invalid_request');
    }
    lines.push({ id: id.trim(), quantity });
  }

  // Two lines for the same product are one line with the quantities added, which is
  // what a platform means and what the totals have to reflect either way.
  const merged = new Map<string, number>();
  for (const line of lines) merged.set(line.id, (merged.get(line.id) ?? 0) + line.quantity);
  return [...merged].map(([id, quantity]) => ({ id, quantity: Math.min(quantity, MAX_QUANTITY) }));
}

/* --------------------------------------------------------------- pricing --- */

interface PricedLine {
  line: CartLineRequest;
  entry: CatalogEntry | undefined;
}

function lineTotal(entry: CatalogEntry, quantity: number): number | null {
  const unit = entry.product.price_minor;
  return unit === null ? null : unit * quantity;
}

/**
 * Builds the cart response UCP's schema requires: `ucp`, `id`, `line_items`,
 * `currency` and `totals`, with exactly one subtotal entry and one total entry.
 */
export async function buildCart(
  lines: CartLineRequest[],
  base: string,
  options: { continueUrl?: string } = {},
): Promise<Record<string, unknown>> {
  const entries = await lookupCatalogEntries(lines.map((line) => line.id));
  const priced: PricedLine[] = lines.map((line) => ({ line, entry: entries.get(line.id) }));

  const known = priced.filter((item): item is PricedLine & { entry: CatalogEntry } => Boolean(item.entry));
  if (known.length === 0) {
    throw new CartError('None of the requested products are in this catalog.', 'invalid_request');
  }

  const cartCurrency = known[0].entry.product.currency || currency();
  const messages: Record<string, unknown>[] = [];

  for (const item of priced) {
    if (!item.entry) {
      messages.push({
        type: 'error',
        code: 'invalid_item',
        // Recoverable: the platform can drop or replace the line and try again.
        severity: 'recoverable',
        content_type: 'plain',
        content: `Product "${item.line.id}" is not in this catalog and was left out of the cart.`,
        path: '$.line_items',
      });
    }
  }

  const lineItems = known.map((item) => {
    const total = lineTotal(item.entry, item.line.quantity);
    const stock = availability(item.entry);

    if (stock && !stock.available) {
      messages.push({
        type: 'warning',
        code: 'out_of_stock',
        content_type: 'plain',
        content: `"${item.entry.product.name}" is currently ${stock.status.replace(/_/g, ' ')}.`,
        path: '$.line_items',
      });
    } else if (
      item.entry.product.stock !== null &&
      item.entry.product.stock < item.line.quantity
    ) {
      messages.push({
        type: 'warning',
        code: 'out_of_stock',
        content_type: 'plain',
        content:
          `Only ${item.entry.product.stock} of "${item.entry.product.name}" remain, ` +
          `fewer than the ${item.line.quantity} requested.`,
        path: '$.line_items',
      });
    }

    return {
      id: `line_${item.entry.product.id}`,
      item: {
        id: item.entry.product.id,
        title: item.entry.product.name,
        ...(item.entry.product.price_minor === null
          ? {}
          : { price: item.entry.product.price_minor }),
        ...(item.entry.product.image ? { image_url: item.entry.product.image } : {}),
      },
      quantity: item.line.quantity,
      totals:
        total === null
          ? []
          : [{ type: 'subtotal', display_text: 'Item subtotal', amount: total }],
    };
  });

  const subtotal = known.reduce((sum, item) => sum + (lineTotal(item.entry, item.line.quantity) ?? 0), 0);

  if (known.some((item) => item.entry.product.price_minor === null)) {
    messages.push({
      type: 'warning',
      code: 'missing_price',
      content_type: 'plain',
      content:
        'One or more products have no published price, so the totals below cover only the ' +
        'priced lines. The final amount is set when the order is placed.',
      path: '$.totals',
    });
  }

  const totals = [
    { type: 'subtotal', display_text: 'Subtotal', amount: subtotal },
    // Shipping and tax are the merchant's own order pipeline's business; Parley never
    // computes them, and inventing a number here would be a quote this service cannot
    // honour. UCP allows a partial estimate before checkout for exactly this reason.
    { type: 'total', display_text: 'Estimated total', amount: subtotal },
  ];

  const id = encodeCartId(known.map((item) => item.line));

  return {
    ucp: responseEnvelope(['dev.ucp.shopping.cart']),
    id,
    line_items: lineItems,
    currency: cartCurrency,
    totals,
    ...(messages.length ? { messages } : {}),
    continue_url: options.continueUrl ?? `${base}/api/mcp`,
    links: [
      {
        type: 'faq',
        title: 'How to complete this purchase',
        url: `${base}/.well-known/agent-commerce.json`,
      },
    ],
  };
}

/**
 * A cart failure, as UCP reports application-level outcomes: HTTP 200 with the
 * problem stated in `messages`, so a platform reads one envelope shape whether the
 * answer was yes or no.
 *
 * This lives here rather than in a route module because Next.js route files may only
 * export route handlers, and all three cart routes need it.
 */
export function cartErrorResponse(err: CartError): Response {
  return json(
    {
      ucp: responseEnvelope(['dev.ucp.shopping.cart']),
      messages: [
        {
          type: 'error',
          code: err.code,
          // A malformed request can be corrected and retried; an id that does not
          // resolve cannot be.
          severity: err.code === 'invalid_request' ? 'recoverable' : 'unrecoverable',
          content_type: 'plain',
          content: err.message,
        },
      ],
    },
    { status: 200, cache: 'no-store' },
  );
}
