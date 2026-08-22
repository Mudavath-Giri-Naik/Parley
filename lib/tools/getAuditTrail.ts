import { readAuditTrail } from '../auditLog';
import { config } from '../config';
import { DatabaseNotConfiguredError } from '../db';
import { formatMoney } from '../money';
import { optionalNumber, optionalString, type ToolDefinition } from './types';

/**
 * The audit trail is deliberately readable by the buyer agent too. A customer's own
 * agent being able to ask "what did you do, and why?" is the point of the whole system.
 */

export const getAuditTrailTool: ToolDefinition = {
  name: 'get_audit_trail',
  title: 'Get audit trail',
  description:
    'Read the recent record of what both agents did and why: every search, stock check, mandate decision, order, and failure, with plain-language reasoning. Use this to answer questions about what happened.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'How many entries to return (1-500, default 50).' },
      customer_ref: { type: 'string', description: 'Optional filter to one customer.' },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    if (!config.db.enabled) throw new DatabaseNotConfiguredError();
    const entries = await readAuditTrail(
      optionalNumber(args, 'limit') ?? 50,
      optionalString(args, 'customer_ref'),
    );
    return {
      count: entries.length,
      entries: entries.map((entry) => ({
        id: entry.id,
        at: entry.createdAt,
        actor: entry.actor,
        action: entry.action,
        result: entry.result,
        reasoning: entry.reasoning,
        customer_ref: entry.customerRef,
        amount:
          entry.amountMinor === null
            ? null
            : formatMoney(entry.amountMinor, entry.currency ?? config.merchant.currency),
        details: entry.details,
      })),
    };
  },
};
