import { publicBaseUrl } from '@/lib/discovery/config';
import { listCatalog, availability, extra, type CatalogEntry } from '@/lib/discovery/catalog';
import { catalogFailure, json, preflight, readJson } from '@/lib/discovery/http';
import { responseEnvelope, toUcpProducts } from '@/lib/discovery/ucp';

/**
 * `POST /api/discovery/ucp/catalog/search` — UCP's `dev.ucp.shopping.catalog.search`.
 *
 * The filtering runs here rather than being pushed down to the merchant's API,
 * because a storefront's own search accepts whatever parameters it happens to accept
 * and this service must give the same answer regardless. Parley's `search_products`
 * makes the same choice for the same reason.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

interface SearchFilters {
  categories?: string[];
  price?: { min?: number; max?: number };
}

function matchesQuery(entry: CatalogEntry, terms: string[]): boolean {
  if (!terms.length) return true;
  const haystack = [
    entry.product.name,
    entry.product.description,
    entry.product.color,
    entry.product.size,
    extra(entry.raw, 'category'),
    extra(entry.raw, 'brand'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  // Every term must appear somewhere. A product matching only one word of
  // "navy cotton tee" is not what the shopper asked for.
  return terms.every((term) => haystack.includes(term));
}

function matchesFilters(entry: CatalogEntry, filters: SearchFilters): boolean {
  const price = entry.product.price_minor;
  if (filters.price?.min !== undefined && (price === null || price < filters.price.min)) return false;
  if (filters.price?.max !== undefined && (price === null || price > filters.price.max)) return false;

  if (filters.categories?.length) {
    const category = (extra(entry.raw, 'category') ?? '').toLowerCase();
    const matched = filters.categories.some((wanted) => category.includes(wanted.toLowerCase()));
    if (!matched) return false;
  }
  return true;
}

/** Cursor is an opaque offset. Opaque to the platform, trivially decodable here. */
function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || !cursor) return 0;
  try {
    const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

export async function POST(req: Request): Promise<Response> {
  const base = publicBaseUrl(req);
  const body = await readJson(req);

  const query = typeof body.query === 'string' ? body.query.trim().toLowerCase() : '';
  const terms = query.split(/\s+/).filter(Boolean);
  const filters = (body.filters ?? {}) as SearchFilters;
  const pagination = (body.pagination ?? {}) as { cursor?: string; limit?: number };

  const requested = Math.trunc(Number(pagination.limit));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = decodeCursor(pagination.cursor);

  let entries: CatalogEntry[];
  try {
    entries = await listCatalog();
  } catch (err) {
    return catalogFailure(err);
  }

  const matched = entries.filter((entry) => matchesQuery(entry, terms) && matchesFilters(entry, filters));

  // Sold-out products sort last but are never dropped: an agent needs to be told the
  // thing exists and cannot be bought, not left to conclude it is not sold here.
  const ranked = [...matched].sort((a, b) => {
    const aAvailable = availability(a)?.available === false ? 1 : 0;
    const bAvailable = availability(b)?.available === false ? 1 : 0;
    return aAvailable - bAvailable;
  });

  // Grouping happens before the page is cut, so a page boundary never splits one
  // product's variants across two responses.
  const products = toUcpProducts(ranked, base);
  const page = products.slice(offset, offset + limit);
  const hasNext = offset + limit < products.length;

  return json({
    ucp: responseEnvelope(['dev.ucp.shopping.catalog.search']),
    products: page,
    pagination: {
      has_next_page: hasNext,
      ...(hasNext ? { cursor: encodeCursor(offset + limit) } : {}),
      total_count: products.length,
    },
    ...(page.length === 0
      ? {
          messages: [
            {
              type: 'info',
              code: 'no_results',
              content_type: 'plain',
              content: query
                ? `Nothing in this catalog matches "${query}". Try a broader query before telling the shopper the item does not exist.`
                : 'This catalog returned no products.',
            },
          ],
        }
      : {}),
  });
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
