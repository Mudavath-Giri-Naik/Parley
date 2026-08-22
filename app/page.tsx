import { config, configStatus } from '@/lib/config';
import { activeTools } from '@/lib/mcp/server';

export const dynamic = 'force-dynamic';

export default function Home() {
  const status = configStatus();
  const merchant = config.merchant.name || 'This merchant';

  return (
    <main className="wrap">
      <p className="eyebrow">Powered by Parley</p>
      <h1>{merchant} · seller agent</h1>
      <p className="lede">
        This deployment lets an AI agent acting for a customer browse {merchant}&apos;s live catalog,
        negotiate within limits {merchant} set, and complete bounded, audited purchases. Connect to it
        over MCP, or read the trail of everything it has done.
      </p>

      {!status.ok && (
        <div className="notice">
          <h3>Configuration incomplete</h3>
          <p style={{ margin: 0, color: 'var(--muted)' }}>
            The MCP endpoint will report these back to any agent that connects:
          </p>
          <ul>
            {status.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <dl className="kv">
          <dt>MCP endpoint</dt>
          <dd className="mono">/api/mcp</dd>
          <dt>Discovery</dt>
          <dd className="mono">
            <a href="/.well-known/agent-commerce.json">/.well-known/agent-commerce.json</a>
          </dd>
          <dt>Audit trail</dt>
          <dd>
            <a href="/dashboard">/dashboard</a>
          </dd>
          <dt>Transport</dt>
          <dd>Streamable HTTP</dd>
          <dt>Tools</dt>
          <dd>{activeTools().length} available</dd>
        </dl>
      </div>

      <h2>What is enabled here</h2>
      <div className="grid">
        <Capability label="Catalog and live stock" on={status.ok} note="Always live, never cached" />
        <Capability
          label="Payments"
          on={status.paymentsEnabled}
          note={status.paymentsEnabled ? 'Payment links, human approval' : 'No payment keys configured'}
        />
        <Capability
          label="Spend mandates"
          on={status.databaseEnabled}
          note={status.databaseEnabled ? `Cap enforced in the database` : 'PARLEY_DB_URL not set'}
        />
        <Capability
          label="Negotiation"
          on={status.agentEnabled}
          note={status.agentEnabled ? `Up to ${config.agent.maxDiscountPercent}% off` : 'ANTHROPIC_API_KEY not set'}
        />
      </div>

      <p className="foot">
        Parley is a self-hosted template. This instance, its API keys, and its data belong to the
        merchant who deployed it.
      </p>
    </main>
  );
}

function Capability({ label, on, note }: { label: string; on: boolean; note: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={{ color: on ? 'var(--success)' : 'var(--muted)' }}>
        {on ? 'On' : 'Off'}
      </div>
      <div className="label" style={{ textTransform: 'none', letterSpacing: 0, marginTop: 4 }}>
        {note}
      </div>
    </div>
  );
}
