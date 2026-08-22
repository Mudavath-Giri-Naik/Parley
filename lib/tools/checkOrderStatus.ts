import { auditLog } from '../auditLog';
import { config } from '../config';
import { callMerchant, isRecord, merchantMessage, merchantUrl, unwrapObject } from '../merchantApi';
import { ToolError, requireString, type ToolDefinition } from './types';

/** Reads order status straight from the merchant's own endpoint. Parley keeps no
 *  shadow copy of order state; the merchant's system remains the source of truth. */

function readStatus(record: Record<string, unknown>): string | undefined {
  for (const key of ['status', 'order_status', 'orderStatus', 'state', 'fulfillment_status']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export async function checkOrderStatus(orderId: string) {
  const response = await callMerchant(merchantUrl(config.merchant.orderStatusApi, orderId, { _ts: Date.now() }));

  if (response.status === 404) {
    await auditLog({
      actor: 'buyer_agent',
      action: 'check_order_status',
      result: 'blocked',
      reasoning: `Order "${orderId}" was not found by the merchant, so no status could be reported.`,
      details: { order_id: orderId },
    });
    throw new ToolError(`No order with id "${orderId}" was found.`);
  }

  if (!response.ok) {
    throw new ToolError(
      `Could not read the status of order "${orderId}" (HTTP ${response.status}): ${merchantMessage(response.data, response.raw)}`,
      { order_id: orderId },
    );
  }

  const record = unwrapObject(response.data) ?? (isRecord(response.data) ? response.data : {});
  const status = readStatus(record);

  await auditLog({
    actor: 'buyer_agent',
    action: 'check_order_status',
    result: 'success',
    reasoning: `Checked order "${orderId}" with the merchant; it is currently ${status ?? 'in an unreported state'}.`,
    details: { order_id: orderId, status },
  });

  return {
    order_id: orderId,
    status: status ?? null,
    note: status ? undefined : 'The merchant did not return a recognizable status field. The raw record is included.',
    order: record,
  };
}

export const checkOrderStatusTool: ToolDefinition = {
  name: 'check_order_status',
  title: 'Check order status',
  description:
    "Look up the current status of an order with the merchant. Use the order id returned by create_order_and_pay. Report exactly what comes back; do not guess at delivery dates.",
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      order_id: { type: 'string', description: 'The order id to look up.' },
    },
    required: ['order_id'],
    additionalProperties: false,
  },
  handler: async (args) => checkOrderStatus(requireString(args, 'order_id')),
};
