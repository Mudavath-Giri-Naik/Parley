import { publicBaseUrl } from '@/lib/discovery/config';
import { buildCart, cartErrorResponse, CartError, decodeCartId, parseLineItems } from '@/lib/discovery/cart';
import { catalogFailure, json, preflight, readJson } from '@/lib/discovery/http';

/**
 * `GET|PUT /api/discovery/ucp/carts/{id}` — read and replace one cart.
 *
 * A GET re-prices the cart the id describes. Because the id carries the contents and
 * nothing is stored, the answer is always computed against the catalog as it is right
 * now: the same cart id fetched an hour apart reports the current price both times,
 * and reports a line as out of stock the moment the merchant sells the last one.
 *
 * UCP defines update as full replacement of `line_items`, so PUT builds a new cart —
 * and therefore returns a new id, since the id is the contents.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Context): Promise<Response> {
  const base = publicBaseUrl(req);
  const { id } = await params;
  try {
    return json(await buildCart(decodeCartId(id), base), { cache: 'no-store' });
  } catch (err) {
    if (err instanceof CartError) return cartErrorResponse(err);
    return catalogFailure(err);
  }
}

export async function PUT(req: Request, { params }: Context): Promise<Response> {
  const base = publicBaseUrl(req);
  const { id } = await params;
  try {
    // Decoded first so an unknown or tampered id fails before any catalog work.
    decodeCartId(id);
    const lines = parseLineItems(await readJson(req));
    return json(await buildCart(lines, base), { cache: 'no-store' });
  } catch (err) {
    if (err instanceof CartError) return cartErrorResponse(err);
    return catalogFailure(err);
  }
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
