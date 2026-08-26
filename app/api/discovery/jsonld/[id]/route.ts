import { publicBaseUrl } from '@/lib/discovery/config';
import {
  CatalogError,
  groupCatalog,
  groupContaining,
  listCatalog,
  lookupCatalogEntry,
} from '@/lib/discovery/catalog';
import { catalogFailure, json, preflight } from '@/lib/discovery/http';
import { groupJsonLd, jsonLdScript, productJsonLd } from '@/lib/discovery/jsonld';

/**
 * `GET /api/discovery/jsonld/{id}` — schema.org Product markup for one product.
 *
 * This exists so a merchant whose storefront is a separate application can inject
 * correct markup into their own product pages without maintaining it by hand. The
 * response carries both the parsed object and a ready-to-paste `<script>` block,
 * generated from the same catalog read everything else here uses — so it goes stale
 * only as fast as the catalog cache, and never disagrees with the feed.
 *
 * `?format=script` returns just the tag, for a template that wants to inline it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Context): Promise<Response> {
  const base = publicBaseUrl(req);
  const { id } = await params;
  const format = new URL(req.url).searchParams.get('format');

  try {
    const groups = groupCatalog(await listCatalog());
    const group = groupContaining(groups, id) ?? groups.find((candidate) => candidate.key === id);

    let payload: Record<string, unknown> | null = null;
    if (group) {
      // A variant id asks about that one variant; a product id asks about the group.
      const variant = group.variants.find((entry) => entry.product.id === id);
      payload = variant ? productJsonLd(variant, base) : groupJsonLd(group, base);
    } else {
      const entry = await lookupCatalogEntry(id);
      if (entry) payload = productJsonLd(entry, base);
    }

    if (!payload) {
      return json(
        { error: 'not_found', message: `No product with id "${id}" exists in this catalog.` },
        { status: 404, cache: 'no-store' },
      );
    }

    const script = `<script type="application/ld+json">${jsonLdScript(payload)}</script>`;

    if (format === 'script') {
      return new Response(script, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return json({ jsonld: payload, script });
  } catch (err) {
    if (err instanceof CatalogError) return catalogFailure(err);
    return catalogFailure(err);
  }
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
