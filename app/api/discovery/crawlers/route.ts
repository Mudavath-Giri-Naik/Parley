import { checkCrawlerAccess } from '@/lib/discovery/crawlers';
import { json, preflight, readJson } from '@/lib/discovery/http';

/**
 * `GET|POST /api/discovery/crawlers` — the crawler access check.
 *
 * GET checks the configured storefront live. POST accepts a robots.txt body and a page
 * body directly, which is how the test suite exercises a known-bad and a known-good
 * robots.txt without needing two real domains — and how a merchant can check a change
 * before they ship it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const report = await checkCrawlerAccess({
    origin: params.get('origin') ?? undefined,
    path: params.get('path') ?? undefined,
  });
  return json(report, { cache: 'no-store' });
}

export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);

  const page =
    typeof body.html === 'string'
      ? {
          url: typeof body.page_url === 'string' ? body.page_url : 'supplied',
          html: body.html,
          expect: (body.expect ?? undefined) as { name?: string; price?: string } | undefined,
        }
      : undefined;

  const report = await checkCrawlerAccess({
    origin: typeof body.origin === 'string' ? body.origin : undefined,
    robotsText: typeof body.robots_txt === 'string' ? body.robots_txt : undefined,
    path: typeof body.path === 'string' ? body.path : undefined,
    crawlers: Array.isArray(body.crawlers)
      ? (body.crawlers as unknown[]).filter((c): c is string => typeof c === 'string')
      : undefined,
    page,
  });

  return json(report, { cache: 'no-store' });
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
