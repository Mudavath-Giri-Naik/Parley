import { publicBaseUrl } from '@/lib/discovery/config';
import { buildCart, cartErrorResponse, CartError, parseLineItems } from '@/lib/discovery/cart';
import { catalogFailure, json, preflight, readJson } from '@/lib/discovery/http';

/**
 * `POST /api/discovery/ucp/carts` — UCP's create-cart operation.
 *
 * Nothing is stored. The returned cart id encodes the lines it was built from, and
 * every read re-prices those lines against the live catalog, so a cart cannot quote a
 * price the merchant has since changed.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const base = publicBaseUrl(req);
  try {
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
