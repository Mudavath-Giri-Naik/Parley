import { Pool, type PoolClient } from 'pg';
import { config, merchantId } from './config';

/**
 * Parley's Postgres.
 *
 * The database is shared across deployments, so every statement runs inside a
 * transaction that first declares which merchant it belongs to. Two things then
 * keep merchants apart, and they are independent of each other:
 *
 *   1. Every query in this codebase filters on merchant_id explicitly.
 *   2. Row Level Security enforces the same filter in the database, against a
 *      role that cannot bypass it. A missed filter above returns no rows rather
 *      than another merchant's rows.
 *
 * The declaration uses set_config(..., true) rather than SET, because it must be
 * transaction-local: Supabase's pooler in transaction mode hands each statement to
 * whichever backend is free, so a session-level SET would not survive to the next
 * statement — and worse, could leak one merchant's context into another's query.
 */

declare global {
  // eslint-disable-next-line no-var
  var __parleyPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __parleySchemaChecked: Promise<void> | undefined;
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

export class SchemaMissingError extends Error {
  constructor(detail: string) {
    super(
      `Parley's tables are not reachable (${detail}). Run supabase/0001_shared_schema.sql ` +
        'against your database, and connect with the parley_app role it creates.',
    );
    this.name = 'SchemaMissingError';
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

/**
 * Confirms the tables exist. The schema itself is owned by the migration, not by
 * the application: parley_app deliberately has no CREATE privilege, so the app
 * cannot alter the shape of a database every merchant shares.
 */
export function ensureSchema(): Promise<void> {
  if (!config.db.url) throw new DatabaseNotConfiguredError();
  if (!global.__parleySchemaChecked) {
    global.__parleySchemaChecked = getPool()
      .query('SELECT 1 FROM audit_log LIMIT 1')
      .then(() => getPool().query('SELECT 1 FROM mandates LIMIT 1'))
      .then(() => undefined)
      .catch((err: unknown) => {
        global.__parleySchemaChecked = undefined;
        throw new SchemaMissingError(err instanceof Error ? err.message : String(err));
      });
  }
  return global.__parleySchemaChecked;
}

/**
 * Runs work inside one transaction that has declared its merchant. Everything
 * touching audit_log or mandates goes through here.
 */
export async function withMerchantContext<T>(
  fn: (client: PoolClient, merchant: string) => Promise<T>,
): Promise<T> {
  await ensureSchema();
  const merchant = merchantId();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Parameterized, and transaction-scoped: `SET LOCAL` cannot take a bind
    // parameter, and a plain `SET` would outlive this transaction on a pooled
    // connection and contaminate the next merchant to borrow it.
    await client.query("SELECT set_config('parley.merchant_id', $1, true)", [merchant]);
    const result = await fn(client, merchant);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs one statement for the current merchant. `$1` is always the merchant id, so
 * every query in the codebase can filter on it without threading it through by hand.
 */
export async function query<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withMerchantContext(async (client, merchant) => {
    const result = await client.query(text, [merchant, ...values]);
    return result.rows as T[];
  });
}
