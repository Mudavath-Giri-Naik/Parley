import { config, configIssues, publicBaseUrl } from '../config';
import { negotiateTool } from '../sellerAgent';
import { tools as baseTools } from '../tools';
import { ToolError, type ToolDefinition } from '../tools/types';

/**
 * A minimal, stateless MCP server speaking JSON-RPC 2.0 over Streamable HTTP.
 *
 * Stateless is the right shape here: every request carries everything it needs, so
 * the endpoint survives serverless cold starts and horizontal scaling without sticky
 * sessions. Remote MCP clients (Claude, ChatGPT, Gemini custom connectors) POST JSON
 * and read a JSON response.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
export const SERVER_VERSION = '1.0.0';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** The seller agent is only offered when this deployment has a key for it. */
export function activeTools(): ToolDefinition[] {
  return config.agent.anthropicApiKey ? [...baseTools, negotiateTool] : [...baseTools];
}

function result(id: JsonRpcRequest['id'], value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function failure(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

function serverInfo() {
  const name = config.merchant.name || 'Parley';
  return {
    name: `${name} (Parley)`,
    title: `${name} seller agent`,
    version: SERVER_VERSION,
  };
}

function instructions(): string {
  return [
    `These tools connect you to ${config.merchant.name}'s live storefront on behalf of your customer.`,
    '',
    'How to use them well:',
    '- search_products and get_product_details tell you what exists and what it costs.',
    '- check_stock is never cached. Call it right before you commit to a purchase.',
    '- create_order_and_pay places a real order. Without a mandate it returns a payment link for your customer to approve; nothing is charged until they pay.',
    '- check_mandate tells you whether a standing spend cap exists. create_mandate records a new one, and only with your customer\'s explicit consent to a specific amount.',
    '- get_audit_trail shows what has happened and why, including anything that was blocked.',
    '',
    `Prices are in minor units of ${config.merchant.currency}. Discounts above the merchant's limit are reduced automatically rather than rejected.`,
  ].join('\n');
}

function toolDescriptor(tool: ToolDefinition) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title,
      readOnlyHint: Boolean(tool.readOnly),
      destructiveHint: Boolean(tool.destructive),
      openWorldHint: true,
    },
  };
}

function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

/** Handles one JSON-RPC message. Returns null for notifications, which take no reply. */
export async function handleRpc(
  message: JsonRpcRequest,
  req: Request,
): Promise<JsonRpcResponse | null> {
  const { method, id, params } = message;

  if (method.startsWith('notifications/')) return null;

  if (method === 'ping') return result(id, {});

  if (method === 'initialize') {
    return result(id, {
      protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: serverInfo(),
      instructions: instructions(),
    });
  }

  // Everything below actually touches the merchant's systems, so the deployment
  // has to be configured. Say exactly what is missing rather than failing vaguely.
  if (configIssues.length) {
    return failure(
      id,
      ErrorCode.InternalError,
      `This Parley deployment is not fully configured: ${configIssues.join(' ')}`,
      { issues: configIssues, dashboard: `${publicBaseUrl(req)}/dashboard` },
    );
  }

  switch (method) {
    case 'tools/list':
      return result(id, { tools: activeTools().map(toolDescriptor) });

    case 'resources/list':
      return result(id, { resources: [] });

    case 'resources/templates/list':
      return result(id, { resourceTemplates: [] });

    case 'prompts/list':
      return result(id, { prompts: [] });

    case 'tools/call': {
      const name = typeof params?.name === 'string' ? params.name : '';
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const tool = activeTools().find((candidate) => candidate.name === name);

      if (!tool) {
        return failure(id, ErrorCode.InvalidParams, `No tool named "${name}" is available.`);
      }

      try {
        const output = await tool.handler(args, { actor: 'buyer_agent' });
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          isError: false,
        });
      } catch (err) {
        // A tool that refuses is a normal outcome the buyer agent should read and act
        // on, not a transport failure. It comes back as content with isError set.
        const text =
          err instanceof ToolError || err instanceof Error ? err.message : String(err);
        console.error(`[parley] tool ${name} failed:`, err);
        return result(id, {
          content: [{ type: 'text', text }],
          isError: true,
        });
      }
    }

    default:
      return failure(id, ErrorCode.MethodNotFound, `Unknown method "${method}".`);
  }
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as JsonRpcRequest).jsonrpc === '2.0' &&
    typeof (value as JsonRpcRequest).method === 'string'
  );
}

/** Optional shared-secret gate. Unset PARLEY_API_KEY leaves the endpoint open. */
export function authorize(req: Request): { ok: true } | { ok: false; response: Response } {
  const expected = config.server.apiKey;
  if (!expected) return { ok: true };

  const header = req.headers.get('authorization') ?? '';
  const presented = header.replace(/^Bearer\s+/i, '').trim();
  if (presented && presented === expected) return { ok: true };

  return {
    ok: false,
    response: new Response(
      JSON.stringify(
        failure(null, ErrorCode.InvalidRequest, 'Missing or invalid bearer token.'),
      ),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="parley"',
          'Access-Control-Allow-Origin': '*',
        },
      },
    ),
  };
}
