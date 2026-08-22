import { readAuditTrail, type AuditEntry } from '@/lib/auditLog';
import { config, configStatus } from '@/lib/config';
import { formatMoney } from '@/lib/money';

/**
 * The audit trail, rendered as a narrative. Each row answers: when, who, what,
 * why, and what happened. If a merchant can read this page and understand every
 * decision their agent made, the system is doing its job.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RESULT_LABEL: Record<string, string> = {
  success: 'success',
  blocked: 'blocked',
  failed: 'failed',
  pending: 'awaiting payment',
  info: 'info',
};

const ACTOR_LABEL: Record<string, string> = {
  seller_agent: 'seller agent',
  buyer_agent: 'buyer agent',
  merchant_api: 'merchant api',
  system: 'system',
  human: 'human',
};

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ limit?: string; customer?: string }>;
}) {
  const params = await searchParams;
  const limit = Number(params.limit) || 100;
  const status = configStatus();

  let entries: AuditEntry[] = [];
  let loadError: string | null = null;

  if (status.databaseEnabled) {
    try {
      entries = await readAuditTrail(limit, params.customer);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  const counts = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.result] = (acc[entry.result] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="wrap">
      <p className="eyebrow">Audit trail</p>
      <h1>{config.merchant.name || 'Parley'}</h1>
      <p className="lede">
        Every action both agents took, in order, with the reasoning behind it. Nothing here is
        reconstructed after the fact: each row was written at the moment the decision was made.
      </p>

      {!status.databaseEnabled && (
        <div className="notice">
          <h3>No audit database configured</h3>
          <p style={{ margin: 0, color: 'var(--muted)' }}>
            Set <code>PARLEY_DB_URL</code> to a Postgres instance you control. Until then, decisions
            are written to the server logs only, and spend mandates are unavailable.
          </p>
        </div>
      )}

      {loadError && (
        <div className="notice">
          <h3>Could not read the audit log</h3>
          <p style={{ margin: 0, color: 'var(--muted)' }}>{loadError}</p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="grid">
          <Stat label="Entries shown" value={String(entries.length)} />
          <Stat label="Succeeded" value={String(counts.success ?? 0)} color="var(--success)" />
          <Stat label="Blocked" value={String(counts.blocked ?? 0)} color="var(--warn)" />
          <Stat label="Failed" value={String(counts.failed ?? 0)} color="var(--danger)" />
        </div>
      )}

      <div className="card">
        {entries.length === 0 ? (
          <p className="empty">
            {status.databaseEnabled && !loadError
              ? 'Nothing has happened yet. Connect an agent to the MCP endpoint and this will fill in.'
              : 'No entries to show.'}
          </p>
        ) : (
          <div className="trail">
            {entries.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>

      <p className="foot">
        Showing up to {limit} entries, newest first. Append <code>?limit=250</code> to see more, or{' '}
        <code>?customer=someone@example.com</code> to follow one customer.
      </p>
    </main>
  );
}

function Entry({ entry }: { entry: AuditEntry }) {
  const when = new Date(entry.createdAt);
  const details = Object.entries(entry.details ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );

  return (
    <div className="entry">
      <time dateTime={entry.createdAt} title={entry.createdAt}>
        {when.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </time>
      <div>
        <div className="head">
          <span className="action mono">{entry.action}</span>
          <span className={`tag ${entry.result}`}>{RESULT_LABEL[entry.result] ?? entry.result}</span>
          <span className="tag actor">{ACTOR_LABEL[entry.actor] ?? entry.actor}</span>
          {entry.amountMinor !== null && (
            <span className="tag actor">
              {formatMoney(entry.amountMinor, entry.currency ?? config.merchant.currency)}
            </span>
          )}
        </div>
        <p className="reasoning">{entry.reasoning}</p>
        {(entry.customerRef || details.length > 0) && (
          <div className="meta mono">
            {entry.customerRef && <span>{entry.customerRef}</span>}
            {entry.customerRef && details.length > 0 && <span> · </span>}
            {details.map(([key, value], index) => (
              <span key={key}>
                {index > 0 && ' · '}
                {key}={typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}
