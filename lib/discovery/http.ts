/**
 * Shared response helpers for the Discovery Service's HTTP surface.
 *
 * Kept separate from Parley's MCP route handling on purpose: these endpoints are
 * read-only, anonymous, and cached, and they answer to crawlers rather than to a
 * negotiating buyer agent. Nothing here can place an order.
 */

import { CatalogError } from './catalog';
import { cacheControl } from './ucp';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, UCP-Agent, API-Version, Authorization',
};

export function json(
  body: unknown,
  init: { status?: number; cache?: string; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': init.cache ?? cacheControl(),
      ...CORS,
      ...init.headers,
    },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * ACP's error shape: `type`, `code`, `message`, optional `param`. Used for the feed
 * endpoints so a platform that already speaks ACP can parse a failure.
 */
export function acpError(
  status: number,
  type: string,
  code: string,
  message: string,
  param?: string,
): Response {
  return json({ type, code, message, ...(param ? { param } : {}) }, { status, cache: 'no-store' });
}

/**
 * UCP reports application-level outcomes inside a 200 envelope and reserves HTTP
 * status codes for transport failures. A catalog that could not be reached is a
 * transport failure of this service's own, so it does get a status code.
 */
export function catalogFailure(err: unknown): Response {
  if (err instanceof CatalogError) {
    return json(
      {
        type: 'service_error',
        code: 'catalog_unavailable',
        message: err.message,
      },
      { status: 502, cache: 'no-store' },
    );
  }
  return json(
    {
      type: 'service_error',
      code: 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    },
    { status: 500, cache: 'no-store' },
  );
}

/** Parses a JSON body, tolerating an empty one so a bare POST is not a 500. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
