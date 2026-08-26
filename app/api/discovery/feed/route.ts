import { publicBaseUrl } from '@/lib/discovery/config';
import { listCatalog } from '@/lib/discovery/catalog';
import { buildFeed, ACP_FEED_VERSION } from '@/lib/discovery/acpFeed';
import { acpError, json, preflight } from '@/lib/discovery/http';
import { CatalogError } from '@/lib/discovery/catalog';

/**
 * `GET /api/discovery/feed` — the ACP product feed, spec version 2026-04-17.
 *
 * Returns the `ProductsResponse` envelope that ACP's `GET /feeds/{id}/products`
 * returns, built from the merchant's live catalog on every request. A platform can
 * poll this directly, or `scripts/discovery-feed-push.mjs` can PATCH the same payload
 * into a feed a platform issued — either way the product mapping exists in exactly
 * one place.
 *
 * Out-of-stock products are included and marked unavailable. Dropping them would tell
 * a shopping agent the merchant does not sell the item, which is a different and worse
 * claim than "sold out".
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    const entries = await listCatalog();
    return json(buildFeed(entries, publicBaseUrl(req)), {
      headers: { 'API-Version': ACP_FEED_VERSION },
    });
  } catch (err) {
    if (err instanceof CatalogError) {
      return acpError(502, 'service_error', 'catalog_unavailable', err.message);
    }
    return acpError(
      500,
      'service_error',
      'internal_error',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
