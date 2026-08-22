import { config } from './config';
import { query } from './db';

/**
 * The shared logging function every tool calls. One row per decision, always with a
 * plain-language `reasoning` string, so the dashboard reads as a narrative rather
 * than as a database dump.
 */

export type AuditActor = 'seller_agent' | 'buyer_agent' | 'system' | 'merchant_api' | 'human';
export type AuditResult = 'success' | 'blocked' | 'failed' | 'pending' | 'info';

export interface AuditEntryInput {
  actor: AuditActor;
  action: string;
  result: AuditResult;
  /** Plain language. Written for a human reading the dashboard, not for a machine. */
  reasoning: string;
  customerRef?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditEntry extends Required<Omit<AuditEntryInput, 'details'>> {
  id: string;
  createdAt: string;
  details: Record<string, unknown>;
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  created_at: Date | string;
  actor: string;
  action: string;
  result: string;
  reasoning: string;
  customer_ref: string | null;
  amount_minor: string | null;
  currency: string | null;
  details: Record<string, unknown> | null;
}

/** Strips anything that should never reach the audit trail. */
const SECRET_KEY_PATTERN = /(secret|password|authorization|api[-_]?key|token)/i;

function redact(details: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      clean[key] = '[redacted]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = redact(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Writes one audit entry. Logging must never be the reason a sale fails, so a
 * database problem is reported to the console and swallowed.
 */
export async function auditLog(entry: AuditEntryInput): Promise<void> {
  const line = `[parley] ${entry.actor} ${entry.action} -> ${entry.result}: ${entry.reasoning}`;
  if (!config.db.enabled) {
    console.log(`${line} (not persisted: PARLEY_DB_URL is unset)`);
    return;
  }
  try {
    await query(
      `INSERT INTO audit_log (actor, action, result, reasoning, customer_ref, amount_minor, currency, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.actor,
        entry.action,
        entry.result,
        entry.reasoning,
        entry.customerRef ?? null,
        entry.amountMinor ?? null,
        entry.currency ?? config.merchant.currency,
        JSON.stringify(redact(entry.details ?? {})),
      ],
    );
  } catch (err) {
    console.error(`${line} (audit write failed)`, err);
  }
}

export async function readAuditTrail(limit = 50, customerRef?: string): Promise<AuditEntry[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  const rows = customerRef
    ? await query<AuditRow>(
        `SELECT * FROM audit_log WHERE customer_ref = $1 ORDER BY id DESC LIMIT $2`,
        [customerRef, capped],
      )
    : await query<AuditRow>(`SELECT * FROM audit_log ORDER BY id DESC LIMIT $1`, [capped]);

  return rows.map((row) => ({
    id: String(row.id),
    createdAt: new Date(row.created_at).toISOString(),
    actor: row.actor as AuditActor,
    action: row.action,
    result: row.result as AuditResult,
    reasoning: row.reasoning,
    customerRef: row.customer_ref,
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
    currency: row.currency,
    details: row.details ?? {},
  }));
}
