import { publicBaseUrl } from '@/lib/discovery/config';
import { groupCatalog, groupContaining, listCatalog, lookupCatalogEntry } from '@/lib/discovery/catalog';
import { catalogFailure, json, preflight, readJson } from '@/lib/discovery/http';
import { responseEnvelope, toUcpProduct } from '@/lib/discovery/ucp';

/**
 * `POST /api/discovery/ucp/catalog/product` — full detail for one product.
 *
 * UCP requires this alongside batch lookup whenever the lookup capability is
 * advertised. Unlike `/catalog/lookup`, a missing product here is an unrecoverable
 * application error rather than a partial result: there is nothing else in the
 * response for the platform to use.
 *
 * The identifier may name either a product or one of its variants, because a platform
 * arriving from a feed or a search result holds a variant id. Either resolves to the
 * whole product, with `selected` naming the variant that was asked for.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const base = publicBaseUrl(req);
  const body = await readJson(req);
  const id = typeof body.id === 'string' ? body.id.trim() : '';

  if (!id) {
    return json(
      {
        ucp: responseEnvelope(['dev.ucp.shopping.catalog.lookup']),
        messages: [
          {
            type: 'error',
            code: 'invalid_request',
            severity: 'unrecoverable',
            content_type: 'plain',
            content: 'id is required.',
            path: '$.id',
          },
        ],
      },
      { status: 200, cache: 'no-store' },
    );
  }

  try {
    const listing = await listCatalog();
    const groups = groupCatalog(listing);

    // A variant id, resolved through the grouped listing.
    let group = groupContaining(groups, id);
    // A product (group) id, as this service mints them.
    if (!group) group = groups.find((candidate) => candidate.key === id);

    // Neither — ask the merchant's single-product endpoint directly, in case the
    // listing is paginated past it.
    if (!group) {
      const entry = await lookupCatalogEntry(id);
      if (entry) group = { key: entry.product.id, title: entry.product.name, variants: [entry] };
    }

    if (!group) {
      return json(
        {
          ucp: responseEnvelope(['dev.ucp.shopping.catalog.lookup']),
          messages: [
            {
              type: 'error',
              code: 'product_not_found',
              severity: 'unrecoverable',
              content_type: 'plain',
              content: `No product with id "${id}" exists in this catalog.`,
              path: '$.id',
            },
          ],
        },
        { status: 200, cache: 'no-store' },
      );
    }

    const selected = group.variants.find((entry) => entry.product.id === id) ?? group.variants[0];

    return json({
      ucp: responseEnvelope(['dev.ucp.shopping.catalog.lookup']),
      product: {
        ...toUcpProduct(group, base),
        selected: selected.product.id,
      },
    });
  } catch (err) {
    return catalogFailure(err);
  }
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
