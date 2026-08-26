import { buildProfile, cacheControl } from '@/lib/discovery/ucp';
import { publicBaseUrl } from '@/lib/discovery/config';

/**
 * `GET /.well-known/ucp` — the UCP business profile.
 *
 * This is the single document a UCP platform fetches to learn what this business can
 * do. It is generated per request from configuration and from Parley's live tool
 * registry, so it cannot describe a deployment other than this one.
 *
 * A merchant with their own domain points that domain's `/.well-known/ucp` here. See
 * docs/DISCOVERY.md — that redirect is the one step this service cannot do for them.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const profile = buildProfile(publicBaseUrl(req));

  return new Response(JSON.stringify(profile, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl(),
      // Platforms fetch this from the browser as often as from a server.
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, UCP-Agent',
    },
  });
}
