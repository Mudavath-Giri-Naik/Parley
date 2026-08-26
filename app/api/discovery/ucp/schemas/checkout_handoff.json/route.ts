import { publicBaseUrl } from '@/lib/discovery/config';
import { json, preflight } from '@/lib/discovery/http';
import { checkoutHandoffSchema } from '@/lib/discovery/ucp';

/**
 * The schema for the checkout-handoff capability declared in `/.well-known/ucp`.
 *
 * UCP binds an entity's authority to the domain its reverse-domain name reverses, and
 * requires the entity's `schema` URL to originate from that same domain. Since this
 * capability is named under the deployment's own hostname, its schema has to be served
 * from here — a platform that validates authority binding will fetch this exact URL
 * and reject the capability if it resolves anywhere else.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const schema = checkoutHandoffSchema(publicBaseUrl(req));
  if (!schema) {
    // This deployment is reached by IP address, so it declares no vendor capability
    // and there is nothing here to describe. The MCP service binding in
    // /.well-known/ucp carries the same routing information.
    return json(
      {
        error: 'no_namespace',
        message:
          'This deployment has no domain name, so it claims no reverse-domain authority and ' +
          'declares no vendor capability. Read the dev.ucp.shopping MCP service binding in ' +
          '/.well-known/ucp for how checkout is completed here.',
      },
      { status: 404, cache: 'no-store' },
    );
  }
  return json(schema);
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
