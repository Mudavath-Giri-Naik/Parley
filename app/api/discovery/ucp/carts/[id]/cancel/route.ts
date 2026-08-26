import { cartErrorResponse, CartError, decodeCartId } from '@/lib/discovery/cart';
import { json, preflight } from '@/lib/discovery/http';
import { responseEnvelope, UCP_VERSION } from '@/lib/discovery/ucp';

/**
 * `POST /api/discovery/ucp/carts/{id}/cancel` — UCP's cancel-cart operation.
 *
 * There is no stored cart to release, so cancelling is an acknowledgement rather than
 * a state change. Saying so plainly is better than pretending to delete something:
 * the platform learns that abandoning a cart here costs nothing and holds no stock.
 * Stock is only ever committed by Parley when an order is actually placed.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  try {
    decodeCartId(id);
  } catch (err) {
    if (err instanceof CartError) return cartErrorResponse(err);
    throw err;
  }

  return json(
    {
      ucp: { ...responseEnvelope(['dev.ucp.shopping.cart']), version: UCP_VERSION, status: 'success' },
      id,
      messages: [
        {
          type: 'info',
          code: 'cart_cancelled',
          content_type: 'plain',
          content:
            'The cart is cancelled. This business does not store carts and does not reserve stock ' +
            'for one, so nothing was held and nothing was released.',
        },
      ],
    },
    { cache: 'no-store' },
  );
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
