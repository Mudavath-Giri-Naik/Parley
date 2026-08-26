import { publicBaseUrl } from '@/lib/discovery/config';
import { listCatalog } from '@/lib/discovery/catalog';

/**
 * `GET /sitemap.xml` — every product page this service renders.
 *
 * Built from the same catalog read as everything else, so a product added to the
 * merchant's catalog appears here within the cache TTL without anything being
 * regenerated or redeployed.
 *
 * Out-of-stock products stay listed. A crawler that has already indexed a product
 * should be able to re-fetch the page and learn it is sold out; dropping the URL
 * instead leaves the old, wrong page in the index.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET(req: Request): Promise<Response> {
  const base = publicBaseUrl(req);

  const entries = await listCatalog().catch(() => []);
  const urls = [
    `${base}/`,
    ...entries.map((entry) => `${base}/p/${encodeURIComponent(entry.product.id)}`),
  ];

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
