import { headers } from 'next/headers';
import { CopyField } from './CopyField';
import { config, configStatus, publicBaseUrl } from '@/lib/config';
import { activeTools } from '@/lib/mcp/server';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const status = configStatus();
  const merchant = config.merchant.name || 'This merchant';

  // Derived from the live request, so the address shown is the one this deployment
  // is actually reachable at rather than anything written down at build time.
  const baseUrl = publicBaseUrl(await headers());
  const mcpUrl = `${baseUrl}/api/mcp`;
  const discoveryUrl = `${baseUrl}/.well-known/agent-commerce.json`;

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
          <dd className="mono">
            <CopyField value={mcpUrl} label="MCP endpoint URL" />
          </dd>
          <dt>Discovery</dt>
          <dd className="mono">
            <CopyField value={discoveryUrl} label="discovery document URL" />
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
        Parley is a self-hosted template. This instance and its API keys belong to the merchant who
        deployed it, and no merchant credential is ever written to Parley&apos;s database. The audit
        trail and spend mandates are stored on shared infrastructure by default, isolated per
        merchant and holding only order and mandate records; point <code>PARLEY_DB_URL</code> at your
        own Postgres to keep that data entirely under your control.
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
