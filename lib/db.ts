import { Pool } from 'pg';
import { config } from './config';

/**
 * Parley's own Postgres. This is deliberately separate from the merchant's product
 * and order database: Parley stores only its audit trail and its spend mandates,
 * and every write the merchant cares about goes through the merchant's own API.
 */

declare global {
  // eslint-disable-next-line no-var
  var __parleyPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __parleySchemaReady: Promise<void> | undefined;
}

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      'PARLEY_DB_URL is not set, so the audit log and mandates are unavailable. ' +
        'Point it at a Postgres instance you control.',
    );
    this.name = 'DatabaseNotConfiguredError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Local databases usually speak plaintext; hosted ones almost always require TLS. */
function shouldUseSsl(url: string): boolean {
  let sslmode: string | null = null;
  let host = '';
  try {
    const parsed = new URL(url);
    sslmode = parsed.searchParams.get('sslmode');
    host = parsed.hostname.toLowerCase();
  } catch {
    return true;
  }
  if (sslmode === 'disable') return false;
  if (sslmode && sslmode !== 'prefer') return true;
  return !LOCAL_HOSTS.has(host);
}

function createPool(url: string): Pool {
  // Managed Postgres (Supabase, Neon, RDS) terminates TLS with certificates that
  // serverless runtimes cannot always chain. Verification is opt-in via PARLEY_DB_SSL_STRICT.
  const strict = process.env.PARLEY_DB_SSL_STRICT === 'true';
  const needsSsl = shouldUseSsl(url);
  return new Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: strict } : undefined,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
}

export function getPool(): Pool {
  if (!config.db.url) throw new DatabaseNotConfiguredError();
  if (!global.__parleyPool) {
    global.__parleyPool = createPool(config.db.url);
    global.__parleyPool.on('error', (err) => {
      console.error('[parley] idle postgres client error', err);
    });
  }
  return global.__parleyPool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor         TEXT        NOT NULL,
  action        TEXT        NOT NULL,
  result        TEXT        NOT NULL,
  reasoning     TEXT        NOT NULL,
  customer_ref  TEXT,
  amount_minor  BIGINT,
  currency      TEXT,
  details       JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_customer_ref_idx ON audit_log (customer_ref);

CREATE TABLE IF NOT EXISTS mandates (
  id             BIGSERIAL PRIMARY KEY,
  customer_ref   TEXT        NOT NULL,
  cap_minor      BIGINT      NOT NULL,
  spent_minor    BIGINT      NOT NULL DEFAULT 0,
  currency       TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'active',
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS mandates_active_customer_idx
  ON mandates (customer_ref) WHERE status = 'active';
`;

/** Creates the two tables Parley owns, once per process. Safe to call on every request. */
export function ensureSchema(): Promise<void> {
  if (!config.db.url) throw new DatabaseNotConfiguredError();
  if (!global.__parleySchemaReady) {
    global.__parleySchemaReady = getPool()
      .query(SCHEMA)
      .then(() => undefined)
      .catch((err) => {
        global.__parleySchemaReady = undefined;
        throw err;
      });
  }
  return global.__parleySchemaReady;
}

export async function query<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  const result = await getPool().query(text, values);
  return result.rows as T[];
}
