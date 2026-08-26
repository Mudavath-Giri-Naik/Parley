import { publicBaseUrl, discoveryConfig } from '@/lib/discovery/config';

/**
 * `GET /robots.txt` — this service's own crawler rules.
 *
 * Written out explicitly rather than left absent. An absent robots.txt allows
 * everything by default, but it states nothing, and a platform or CDN default can
 * later fill the gap with rules the merchant never chose. The named AI crawlers are
 * allowed by name so the permission survives that.
 *
 * The dashboard and the MCP endpoint are excluded: neither is content, and one of
 * them is an API a crawler has no business walking.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const base = publicBaseUrl(req);

  const lines: string[] = [
    '# Served by the Parley Discovery Service.',
    '# Product pages and the machine-readable catalog are open to every crawler,',
    '# including the AI crawlers named individually below.',
    '',
  ];

  for (const crawler of discoveryConfig.crawlers) {
    lines.push(`User-agent: ${crawler}`, 'Allow: /', '');
  }

  lines.push(
    'User-agent: *',
    'Allow: /',
    'Allow: /p/',
    'Allow: /.well-known/',
    'Allow: /api/discovery/',
    'Disallow: /dashboard',
    'Disallow: /api/mcp',
    'Disallow: /api/agent/',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
    '# Machine-readable catalog:',
    `#   UCP profile   ${base}/.well-known/ucp`,
    `#   ACP feed      ${base}/api/discovery/feed`,
    `#   MCP endpoint  ${base}/api/mcp (for agents, not crawlers)`,
    '',
  );

  return new Response(lines.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
