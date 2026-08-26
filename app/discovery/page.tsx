import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { publicBaseUrl } from '@/lib/config';
import { discoveryConfig, merchantName } from '@/lib/discovery/config';
import { checkCrawlerAccess, type CheckStatus } from '@/lib/discovery/crawlers';
import { APPEARANCE_DISCLAIMER, readProbes } from '@/lib/discovery/appearance';
import { UCP_VERSION } from '@/lib/discovery/ucp';
import { ACP_FEED_VERSION } from '@/lib/discovery/acpFeed';

/**
 * The one page a merchant reads.
 *
 * Everything else this service produces is written for machines. This page answers
 * the two questions a merchant actually has — "can the AI crawlers see my shop?" and
 * "has anything actually shown up?" — in plain language, and is careful not to
 * overclaim on the second one.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Discovery report',
  robots: { index: false, follow: false },
};

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  warn: 'CHECK',
  unknown: 'UNKNOWN',
};

const STATUS_COLOR: Record<CheckStatus, string> = {
  pass: '#4ade80',
  fail: '#f87171',
  warn: '#fbbf24',
  unknown: '#94a3b8',
};

function Badge({ status }: { status: CheckStatus }) {
  return (
    <span
      className="tag"
      style={{ color: STATUS_COLOR[status], borderColor: STATUS_COLOR[status] }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export default async function DiscoveryReport() {
  const base = publicBaseUrl(await headers());

  // Both halves are allowed to fail independently: a merchant with no database
  // configured should still get the crawler check, and vice versa.
  const [report, history] = await Promise.all([
    checkCrawlerAccess().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })),
    readProbes(25).catch(() => ({ source: 'none', probes: [] })),
  ]);

  const testable = history.probes.filter((probe) => probe.testable);
  const untestable = history.probes.filter((probe) => !probe.testable);

  return (
    <main className="wrap">
      <p className="eyebrow">Discovery Service</p>
      <h1>Can AI shopping agents find {merchantName()}?</h1>
      <p className="lede">
        Three machine-readable descriptions of this catalog are published from the live product
        data: a UCP profile ({UCP_VERSION}), an ACP product feed ({ACP_FEED_VERSION}), and
        schema.org markup on every product page. Below is whether crawlers can actually reach them,
        and what has been observed since.
      </p>

      <div className="card">
        <h2>What is published</h2>
        <dl className="kv">
          <dt>UCP profile</dt>
          <dd>
            <a href="/.well-known/ucp" className="mono">
              {base}/.well-known/ucp
            </a>
          </dd>
          <dt>ACP feed</dt>
          <dd>
            <a href="/api/discovery/feed" className="mono">
              {base}/api/discovery/feed
            </a>
          </dd>
          <dt>Sitemap</dt>
          <dd>
            <a href="/sitemap.xml" className="mono">
              {base}/sitemap.xml
            </a>
          </dd>
          <dt>Catalog cache</dt>
          <dd>
            {discoveryConfig.cacheTtlMs === 0
              ? 'disabled — every request reads the catalog live'
              : `${Math.round(discoveryConfig.cacheTtlMs / 1000)}s — a price or stock change appears within that window`}
          </dd>
        </dl>
      </div>

      <div className="card">
        <h2>Crawler access</h2>
        {'error' in report ? (
          <p className="empty">The crawler check could not run: {report.error}</p>
        ) : (
          <>
            <p style={{ color: 'var(--muted)' }}>
              {report.robots.explanation}
              {report.robots.url ? (
                <>
                  {' '}
                  <span className="mono">{report.robots.url}</span>
                </>
              ) : null}
            </p>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {report.crawlers.map((verdict) => (
                <li key={verdict.crawler} className="entry">
                  <Badge status={verdict.status} />{' '}
                  <strong className="mono">{verdict.crawler}</strong>
                  <p style={{ margin: '0.35rem 0 0', color: 'var(--muted)' }}>{verdict.explanation}</p>
                </li>
              ))}
              <li className="entry">
                <Badge status={report.serverRendering.status} />{' '}
                <strong>Readable without JavaScript</strong>
                <p style={{ margin: '0.35rem 0 0', color: 'var(--muted)' }}>
                  {report.serverRendering.explanation}
                </p>
              </li>
            </ul>
          </>
        )}
      </div>

      <div className="card">
        <h2>Appearance log</h2>
        <div className="notice">
          <h3>Read this first</h3>
          <p style={{ margin: 0, color: 'var(--muted)' }}>{APPEARANCE_DISCLAIMER}</p>
        </div>

        {testable.length === 0 && untestable.length === 0 ? (
          <p className="empty">
            No probes have been run yet. Run <span className="mono">npm run discovery:probe</span>, or
            POST to <span className="mono">/api/discovery/appearance</span>.
          </p>
        ) : (
          <div className="trail">
            {testable.map((probe, index) => (
              <div className="entry" key={`${probe.observedAt}-${index}`}>
                <p style={{ margin: 0 }}>
                  <span className="tag">{probe.platform}</span>{' '}
                  <span className="mono" style={{ color: 'var(--muted)' }}>
                    {probe.observedAt}
                  </span>{' '}
                  {probe.mentioned === true ? (
                    <span style={{ color: STATUS_COLOR.pass }}>named this merchant</span>
                  ) : probe.error ? (
                    <span style={{ color: STATUS_COLOR.warn }}>errored</span>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>did not name this merchant</span>
                  )}
                </p>
                <p style={{ margin: '0.35rem 0 0' }}>
                  <strong>Asked:</strong> {probe.question}
                </p>
                <p style={{ margin: '0.35rem 0 0', color: 'var(--muted)' }}>
                  {probe.error ? probe.error : (probe.answer ?? '').slice(0, 600)}
                  {(probe.answer ?? '').length > 600 ? '…' : ''}
                </p>
                {probe.via && (
                  <p className="foot" style={{ margin: '0.35rem 0 0' }}>
                    via {probe.via}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {untestable.length > 0 && (
          <>
            <h3>Not testable</h3>
            <ul>
              {untestable.map((probe, index) => (
                <li key={`${probe.observedAt}-${index}`}>
                  <strong>{probe.platform}</strong> — {probe.error ?? 'no programmatic interface configured'}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <p className="foot">
        Parley handles the purchase itself; this service only handles being found. Probe history is
        stored in <span className="mono">{history.source}</span>.
      </p>
    </main>
  );
}
