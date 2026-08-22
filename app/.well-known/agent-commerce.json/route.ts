import { config, configStatus, publicBaseUrl } from '@/lib/config';
import { LATEST_PROTOCOL_VERSION, SERVER_VERSION, activeTools } from '@/lib/mcp/server';

/**
 * The discovery document.
 *
 * Any AI agent that finds this file learns who the merchant is, where the MCP
 * endpoint lives, and what it can do there. It is generated from config at request
 * time, so it is never out of step with the deployment.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const base = publicBaseUrl(req);
  const status = configStatus();

  const document = {
    schema_version: '2026-02-01',
    merchant: {
      name: config.merchant.name || 'Unconfigured merchant',
      currency: config.merchant.currency,
    },
    agent: {
      persona: config.agent.persona,
      max_discount_percent: config.agent.maxDiscountPercent,
      conversational: status.agentEnabled,
    },
    endpoints: {
      mcp: `${base}/api/mcp`,
      dashboard: `${base}/dashboard`,
    },
    mcp: {
      transport: 'streamable-http',
      url: `${base}/api/mcp`,
      protocol_version: LATEST_PROTOCOL_VERSION,
      authentication: config.server.apiKey
        ? { type: 'bearer', description: 'Send Authorization: Bearer <token> issued by the merchant.' }
        : { type: 'none' },
      tools: activeTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        read_only: Boolean(tool.readOnly),
      })),
    },
    capabilities: {
      catalog_search: true,
      live_stock: true,
      negotiation: status.agentEnabled,
      spend_mandates: status.databaseEnabled,
      payments: status.paymentsEnabled,
      audit_trail: status.databaseEnabled,
    },
    powered_by: { name: 'Parley', version: SERVER_VERSION },
    ...(status.ok ? {} : { configuration_incomplete: status.issues }),
  };

  return new Response(JSON.stringify(document, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
