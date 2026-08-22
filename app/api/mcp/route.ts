import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  authorize,
  handleRpc,
  isJsonRpcRequest,
  type JsonRpcResponse,
} from '@/lib/mcp/server';

/**
 * The MCP endpoint. Streamable HTTP, not stdio: this is what remote and custom
 * connectors in Claude, ChatGPT and Gemini can actually reach.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
      ...CORS,
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<Response> {
  const auth = authorize(req);
  if (!auth.ok) return auth.response;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json(
      { jsonrpc: '2.0', id: null, error: { code: ErrorCode.ParseError, message: 'Request body is not valid JSON.' } },
      400,
    );
  }

  // A client may send a single message or a batch of them.
  const messages = Array.isArray(payload) ? payload : [payload];
  if (!messages.length) {
    return json(
      { jsonrpc: '2.0', id: null, error: { code: ErrorCode.InvalidRequest, message: 'Empty batch.' } },
      400,
    );
  }

  const responses: JsonRpcResponse[] = [];
  for (const message of messages) {
    if (!isJsonRpcRequest(message)) {
      responses.push({
        jsonrpc: '2.0',
        id: null,
        error: { code: ErrorCode.InvalidRequest, message: 'Not a valid JSON-RPC 2.0 request.' },
      });
      continue;
    }
    try {
      const response = await handleRpc(message, req);
      if (response) responses.push(response);
    } catch (err) {
      console.error('[parley] MCP handler error:', err);
      responses.push({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: {
          code: ErrorCode.InternalError,
          message: err instanceof Error ? err.message : 'Unexpected server error.',
        },
      });
    }
  }

  // Notifications only: acknowledge with no body, per the Streamable HTTP transport.
  if (!responses.length) return new Response(null, { status: 202, headers: CORS });

  return json(Array.isArray(payload) ? responses : responses[0]);
}

/**
 * This server never initiates messages, so there is no server-to-client stream to
 * open. Declining the GET is the correct answer and clients handle it.
 */
export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: ErrorCode.InvalidRequest,
        message: 'This MCP server is stateless and does not offer a server-initiated SSE stream. POST JSON-RPC requests instead.',
      },
    }),
    {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'POST, DELETE, OPTIONS', ...CORS },
    },
  );
}

/** Session teardown. Nothing is stored per session, so there is nothing to tear down. */
export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
