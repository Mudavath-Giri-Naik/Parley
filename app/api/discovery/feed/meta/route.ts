import { createHash } from 'node:crypto';
import { merchantId } from '@/lib/config';
import { catalogCacheAgeMs, listCatalog, CatalogError } from '@/lib/discovery/catalog';
import { buildFeedMetadata, ACP_FEED_VERSION } from '@/lib/discovery/acpFeed';
import { acpError, json, preflight } from '@/lib/discovery/http';

/**
 * `GET /api/discovery/feed/meta` — the ACP `FeedMetadata` resource.
 *
 * The feed id is derived from the deployment rather than issued by a platform,
 * because this feed is pulled rather than created through ACP's `POST /feeds`. It is
 * stable across restarts and unique per deployment, so two merchants sharing this
 * codebase never collide.
 *
 * `updated_at` reports when the catalog behind the feed was last actually read. It is
 * not a claim about when the merchant last changed a product — the catalog publishes
 * no such timestamp, and inventing one would misrepresent the feed's freshness.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function feedId(): string {
  const digest = createHash('sha256').update(merchantId()).digest('base64url').slice(0, 12);
  return `feed_${digest}`;
}

export async function GET(_req: Request): Promise<Response> {
  try {
    await listCatalog();
    const age = catalogCacheAgeMs() ?? 0;
    const readAt = new Date(Date.now() - age);

    return json(buildFeedMetadata(feedId(), readAt), {
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
