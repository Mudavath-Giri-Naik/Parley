import { publicBaseUrl } from '@/lib/discovery/config';
import { groupCatalog, lookupCatalogEntries } from '@/lib/discovery/catalog';
import { catalogFailure, json, preflight, readJson } from '@/lib/discovery/http';
import { responseEnvelope, toUcpProduct } from '@/lib/discovery/ucp';

/**
 * `POST /api/discovery/ucp/catalog/lookup` — UCP's batch lookup.
 *
 * Partial success is the normal outcome, not an error: UCP asks for the products
 * that resolved plus a message naming the identifiers that did not, so a platform
 * correlating a list of ids learns exactly which ones this catalog does not carry.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_IDS = 100;

export async function POST(req: Request): Promise<Response> {
  const base = publicBaseUrl(req);
  const body = await readJson(req);

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '').slice(0, MAX_IDS)
    : [];

  if (!ids.length) {
    return json(
      {
        ucp: responseEnvelope(['dev.ucp.shopping.catalog.lookup']),
        products: [],
        messages: [
          {
            type: 'error',
            code: 'invalid_request',
            severity: 'unrecoverable',
            content_type: 'plain',
            content: 'ids must be a non-empty array of product identifiers.',
            path: '$.ids',
          },
        ],
      },
      { cache: 'no-store' },
    );
  }

  let found: Map<string, Awaited<ReturnType<typeof lookupCatalogEntries>> extends Map<string, infer T> ? T : never>;
  try {
    found = await lookupCatalogEntries(ids);
  } catch (err) {
    return catalogFailure(err);
  }

  const entries = ids.map((id) => found.get(id)).filter((entry) => entry !== undefined);
  const products = groupCatalog(entries).map((group) => toUcpProduct(group, base));

  const missing = ids.filter((id) => !found.has(id));

  return json({
    ucp: responseEnvelope(['dev.ucp.shopping.catalog.lookup']),
    products,
    ...(missing.length
      ? {
          messages: [
            {
              type: 'error',
              code: 'product_not_found',
              // Retrying the same identifier will not help; the platform needs a
              // different one.
              severity: 'unrecoverable',
              content_type: 'plain',
              content: `Not in this catalog: ${missing.join(', ')}.`,
              path: '$.ids',
            },
          ],
        }
      : {}),
  });
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
