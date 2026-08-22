import { auditLog } from '../auditLog';
import { config } from '../config';
import { DatabaseNotConfiguredError, query } from '../db';
import { formatMoney } from '../money';
import {
  ToolError,
  optionalNumber,
  optionalString,
  requireString,
  type ToolDefinition,
} from './types';

/**
 * A mandate is a standing, bounded permission: "this customer's agent may spend up
 * to X on their behalf without stopping to ask a human". It is the only thing that
 * lets a purchase complete without human approval, and it is enforced in Postgres
 * with a conditional UPDATE, not in the agent's judgement.
 */

export interface Mandate {
  id: string;
  customer_ref: string;
  cap_minor: number;
  spent_minor: number;
  remaining_minor: number;
  currency: string;
  status: 'active' | 'exhausted' | 'expired' | 'revoked';
  note: string | null;
  created_at: string;
  expires_at: string | null;
}

interface MandateRow extends Record<string, unknown> {
  id: string;
  customer_ref: string;
  cap_minor: string;
  spent_minor: string;
  currency: string;
  status: string;
  note: string | null;
  created_at: Date | string;
  expires_at: Date | string | null;
}

function toMandate(row: MandateRow): Mandate {
  const cap = Number(row.cap_minor);
  const spent = Number(row.spent_minor);
  return {
    id: String(row.id),
    customer_ref: row.customer_ref,
    cap_minor: cap,
    spent_minor: spent,
    remaining_minor: Math.max(0, cap - spent),
    currency: row.currency,
    status: row.status as Mandate['status'],
    note: row.note,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}

function requireDatabase(): void {
  if (!config.db.enabled) throw new DatabaseNotConfiguredError();
}

/** Returns the customer's active mandate, expiring it first if its window has passed. */
export async function getActiveMandate(customerRef: string): Promise<Mandate | null> {
  requireDatabase();
  await query(
    `UPDATE mandates SET status = 'expired'
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()`,
  );
  const rows = await query<MandateRow>(
    `SELECT * FROM mandates WHERE customer_ref = $1 AND status = 'active' LIMIT 1`,
    [customerRef],
  );
  return rows.length ? toMandate(rows[0]) : null;
}

export async function createMandate(input: {
  customerRef: string;
  capMinor?: number;
  note?: string;
  ttlDays?: number;
}): Promise<Mandate> {
  requireDatabase();
  const capMinor = Math.round(input.capMinor ?? config.mandates.spendCapDefault);
  if (!Number.isFinite(capMinor) || capMinor <= 0) {
    throw new ToolError('The spend cap must be a positive amount in minor units (paise, cents).');
  }

  const existing = await getActiveMandate(input.customerRef);
  if (existing) {
    throw new ToolError(
      `An active mandate already exists for "${input.customerRef}" with ${formatMoney(existing.remaining_minor, existing.currency)} remaining. Use it, or let it expire before creating another.`,
      { mandate: existing as unknown as Record<string, unknown> },
    );
  }

  const ttlDays = input.ttlDays ?? config.mandates.defaultTtlDays;
  const rows = await query<MandateRow>(
    `INSERT INTO mandates (customer_ref, cap_minor, currency, note, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
     RETURNING *`,
    [input.customerRef, capMinor, config.merchant.currency, input.note ?? null, String(ttlDays)],
  );

  const mandate = toMandate(rows[0]);
  await auditLog({
    actor: 'human',
    action: 'create_mandate',
    result: 'success',
    reasoning:
      `A spend mandate of ${formatMoney(mandate.cap_minor, mandate.currency)} was created for "${input.customerRef}", valid for ${ttlDays} days. ` +
      'Purchases within this cap can now complete without a separate human approval step.',
    customerRef: input.customerRef,
    amountMinor: mandate.cap_minor,
    currency: mandate.currency,
    details: { mandate_id: mandate.id, ttl_days: ttlDays, note: input.note },
  });
  return mandate;
}

export interface SpendResult {
  ok: boolean;
  mandate?: Mandate;
  reason?: string;
}

/**
 * Atomically charges an amount against a mandate. The cap is enforced by the WHERE
 * clause, so two concurrent orders cannot both slip under the same remaining balance.
 */
export async function spendAgainstMandate(
  customerRef: string,
  amountMinor: number,
): Promise<SpendResult> {
  requireDatabase();
  const rows = await query<MandateRow>(
    `UPDATE mandates
        SET spent_minor = spent_minor + $2,
            status = CASE WHEN spent_minor + $2 >= cap_minor THEN 'exhausted' ELSE status END
      WHERE customer_ref = $1
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > now())
        AND spent_minor + $2 <= cap_minor
      RETURNING *`,
    [customerRef, Math.round(amountMinor)],
  );

  if (rows.length) return { ok: true, mandate: toMandate(rows[0]) };

  const current = await getActiveMandate(customerRef);
  if (!current) {
    return { ok: false, reason: `No active mandate exists for "${customerRef}".` };
  }
  return {
    ok: false,
    mandate: current,
    reason:
      `This purchase of ${formatMoney(amountMinor, current.currency)} exceeds the remaining mandate balance of ` +
      `${formatMoney(current.remaining_minor, current.currency)}.`,
  };
}

/** Releases an amount back to a mandate when a charge could not be completed. */
export async function refundToMandate(customerRef: string, amountMinor: number): Promise<void> {
  if (!config.db.enabled) return;
  await query(
    `UPDATE mandates
        SET spent_minor = GREATEST(0, spent_minor - $2),
            status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END
      WHERE customer_ref = $1 AND status IN ('active', 'exhausted')`,
    [customerRef, Math.round(amountMinor)],
  );
}

export const checkMandateTool: ToolDefinition = {
  name: 'check_mandate',
  title: 'Check spend mandate',
  description:
    'Look up the active spend mandate for a customer reference: the cap, how much has been spent, and how much remains. A purchase can only skip human approval if it fits inside the remaining balance.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      customer_ref: {
        type: 'string',
        description: 'Stable identifier for the customer, such as their email address.',
      },
    },
    required: ['customer_ref'],
    additionalProperties: false,
  },
  handler: async (args) => {
    const customerRef = requireString(args, 'customer_ref');
    const mandate = await getActiveMandate(customerRef);
    if (!mandate) {
      return {
        has_mandate: false,
        customer_ref: customerRef,
        message:
          `No active spend mandate for "${customerRef}". Purchases will require human approval via a payment link, ` +
          'or the customer can authorize a cap with create_mandate.',
        default_cap_minor: config.mandates.spendCapDefault,
        currency: config.merchant.currency,
      };
    }
    return {
      has_mandate: true,
      ...mandate,
      remaining_display: formatMoney(mandate.remaining_minor, mandate.currency),
    };
  },
};

export const createMandateTool: ToolDefinition = {
  name: 'create_mandate',
  title: 'Create spend mandate',
  description:
    'Record a customer-authorized spending cap. Only call this when the customer has explicitly agreed to a limit; it is the permission that lets later purchases complete without asking a human each time.',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      customer_ref: {
        type: 'string',
        description: 'Stable identifier for the customer, such as their email address.',
      },
      cap_minor: {
        type: 'number',
        description:
          'The cap in minor units (paise, cents). Defaults to the merchant\'s SPEND_CAP_DEFAULT.',
      },
      note: { type: 'string', description: 'What the customer authorized, in their own words.' },
      ttl_days: { type: 'number', description: 'How long the mandate stays valid (default from config).' },
    },
    required: ['customer_ref'],
    additionalProperties: false,
  },
  handler: async (args) =>
    createMandate({
      customerRef: requireString(args, 'customer_ref'),
      capMinor: optionalNumber(args, 'cap_minor'),
      note: optionalString(args, 'note'),
      ttlDays: optionalNumber(args, 'ttl_days'),
    }),
};
