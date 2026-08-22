import type { Conversation } from '@/lib/agentProviders';
import { AgentNotConfiguredError, runSellerAgent } from '@/lib/sellerAgent';
import { authorize } from '@/lib/mcp/server';
import { configIssues } from '@/lib/config';

/**
 * A direct line to the seller agent, for merchants who want to talk to their own
 * agent (or embed it in a storefront widget) without going through MCP.
 *
 * The conversation is stateless: pass the `messages` array back from the previous
 * response to continue a thread.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const auth = authorize(req);
  if (!auth.ok) return auth.response;

  if (configIssues.length) {
    return Response.json(
      { error: 'This Parley deployment is not fully configured.', issues: configIssues },
      { status: 503 },
    );
  }

  let body: { message?: unknown; messages?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return Response.json({ error: '"message" is required.' }, { status: 400 });
  }

  const history = Array.isArray(body.messages) ? (body.messages as Conversation) : [];

  try {
    const turn = await runSellerAgent(message, history);
    return Response.json({
      reply: turn.reply,
      provider: turn.provider,
      model: turn.model,
      tools_used: turn.toolCalls.map((call) => ({ name: call.name, ok: call.ok })),
      messages: turn.messages,
    });
  } catch (err) {
    if (err instanceof AgentNotConfiguredError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    console.error('[parley] seller agent error:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'The seller agent failed.' },
      { status: 500 },
    );
  }
}
