import { parleyConfig } from '@/lib/discovery/config';
import { APPEARANCE_DISCLAIMER, readProbes, runAppearanceAudit } from '@/lib/discovery/appearance';
import { json, preflight } from '@/lib/discovery/http';

/**
 * `GET|POST /api/discovery/appearance` — the appearance probe log.
 *
 * GET reads the history. POST runs a fresh round, which costs money at whichever
 * providers are configured and takes as long as the slowest of them, so it is
 * protected by the same bearer token that protects Parley's MCP endpoint when one is
 * set. A deployment with no token set leaves this open, exactly as it leaves MCP open.
 *
 * Every response repeats the disclaimer. It is the most important field in the
 * document: these rows are observations of single answers, not a ranking and not a
 * promise about future ones.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const expected = parleyConfig.server.apiKey;
  if (!expected) return true;
  const header = req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/i, '').trim() === expected;
}

export async function GET(req: Request): Promise<Response> {
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 50);
  const { source, probes } = await readProbes(limit);

  // Three outcomes, kept apart. A probe that errored is not a probe that ran and
  // found nothing, and reporting them together would understate the merchant's
  // visibility as confidently as it overstated it.
  const answered = probes.filter((probe) => probe.testable && !probe.error);
  const errored = probes.filter((probe) => probe.testable && probe.error);
  const notTestable = probes.filter((probe) => !probe.testable);
  const mentioned = answered.filter((probe) => probe.mentioned === true);

  return json(
    {
      disclaimer: APPEARANCE_DISCLAIMER,
      stored_in: source,
      count: probes.length,
      observations: {
        answers_received: answered.length,
        answers_naming_this_merchant: mentioned.length,
        probes_that_errored: errored.length,
        platforms_not_testable: notTestable.length,
        note:
          answered.length === 0
            ? 'No assistant returned an answer, so nothing at all has been observed yet. ' +
              'This is not evidence of absence from AI search results — it is the absence of a measurement.'
            : 'A count of answers, not of positions. Nothing here observes where a merchant ranked, ' +
              'because none of these interfaces reports a rank.',
      },
      probes,
    },
    { cache: 'no-store' },
  );
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return json(
      { error: 'unauthorized', message: 'Send Authorization: Bearer <PARLEY_API_KEY> to run a probe.' },
      { status: 401, cache: 'no-store' },
    );
  }

  const limit = Number(new URL(req.url).searchParams.get('questions') ?? 2);
  const run = await runAppearanceAudit({ questionLimit: Number.isFinite(limit) ? limit : 2 });
  return json(run, { cache: 'no-store' });
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
