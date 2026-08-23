import { config, configStatus, publicBaseUrl } from '@/lib/config';
import { LATEST_PROTOCOL_VERSION, SERVER_VERSION, activeTools } from '@/lib/mcp/server';

/**
 * The discovery document.
 *
 * Any AI agent that finds this file learns who the merchant is, where the MCP
 * endpoint lives, and what it can do there. It is generated from config at request
 * time, so it is never out of step with the deployment.
 *
 * The agentic_commerce_protocol block is a translation aid, not an implementation.
 * Parley serves MCP tools, not ACP's REST endpoints; the block only names which ACP
 * concepts those tools correspond to, so an agent fluent in ACP can read this
 * deployment without guessing. Field names in it were taken from ACP spec 2026-04-17
 * (openapi.agentic_checkout.yaml). Nothing here changes tool behaviour.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * How Parley's own order vocabulary lines up with ACP's.
 *
 * Deliberately descriptive rather than generative: Parley does not build a
 * checkout_session object, so this maps concepts instead of pretending to serve one.
 */
const agenticCommerceProtocol = {
  compliance: 'none',
  relationship: 'vocabulary_alignment_only',
  summary:
    'Parley does not implement ACP\'s REST endpoints and does not serve a checkout session resource. ' +
    'The mapping below is descriptive only: it names the ACP concepts that Parley\'s existing MCP tools ' +
    'correspond to, so an agent that already speaks ACP can read this deployment without a translation layer. ' +
    'Call the MCP tools described above; there is no ACP endpoint here to call.',
  spec_version_referenced: '2026-04-17',
  spec_urls: {
    specification: 'https://github.com/agentic-commerce-protocol/agentic-commerce-protocol',
    checkout_reference: 'https://www.agenticcommerce.dev/docs/reference/checkout',
  },
  amount_convention:
    'Integer minor units, which matches ACP. Parley\'s *_minor fields are already in this form.',
  checkout_session: {
    equivalent_tool: 'create_order_and_pay',
    note:
      'One create_order_and_pay call corresponds to a single-line-item ACP checkout session. Parley returns the ' +
      'outcome inline and issues no session id, so there is no session resource to create, update or poll.',
    field_mapping: {
      id: 'order_id, when the merchant\'s order API returns one',
      status: 'derived from outcome — see status_mapping',
      currency: 'currency (ISO 4217)',
      line_items: 'exactly one entry — see line_items below',
      totals: 'see line_items.field_mapping; Parley reports two amounts, not a totals array',
    },
    not_provided: [
      'capabilities',
      'buyer',
      'messages',
      'links',
      'fulfillment_options',
      'fulfillment_details',
      'fulfillment_groups',
      'quote_id',
      'expires_at',
      'continue_url',
      'discounts',
    ],
  },
  line_items: {
    cardinality: 'exactly one per order; Parley has no multi-item cart',
    field_mapping: {
      'item.id': 'product.id',
      'item.name': 'product.name',
      quantity: 'quantity',
      unit_amount: 'list_price_minor divided by quantity',
      'totals[type=items_base_amount].amount': 'list_price_minor',
      'totals[type=discount].amount': 'list_price_minor minus amount_minor',
      'totals[type=total].amount': 'amount_minor',
    },
    not_provided: ['sku', 'variant_id', 'category', 'weight', 'dimensions', 'tax_exempt'],
  },
  status_mapping: {
    note:
      'Parley\'s create_order_and_pay outcome on the left, the nearest ACP checkout session status on the right. ' +
      'Approximate by design: ACP draws distinctions Parley does not, and Parley separates a merchant outage from ' +
      'a stock refusal where ACP has one status for both.',
    completed: 'completed',
    awaiting_approval: 'ready_for_payment',
    blocked: 'not_ready_for_payment',
    unavailable: 'not_ready_for_payment',
    failed: 'canceled',
  },
} as const;

export async function GET(req: Request): Promise<Response> {
  const base = publicBaseUrl(req);
  const status = configStatus();

  const document = {
    notice:
      'This discovery document uses vocabulary aligned with the Agentic Commerce Protocol ' +
      '(agenticcommerce.dev) for broader legibility. This is not a claim of full ACP compliance.',
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
    agentic_commerce_protocol: agenticCommerceProtocol,
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
