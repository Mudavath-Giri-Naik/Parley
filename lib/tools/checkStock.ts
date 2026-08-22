import { auditLog } from '../auditLog';
import { config } from '../config';
import {
  callMerchant,
  merchantMessage,
  merchantUrl,
  normalizeProduct,
  unwrapObject,
} from '../merchantApi';
import { ToolError, optionalNumber, requireString, type ToolDefinition } from './types';

/**
 * Stock is the one answer that must never be stale. This tool always hits the
 * merchant's live endpoint with `cache: 'no-store'`, and nothing here is memoized.
 */

export interface StockResult {
  product_id: string;
  name: string;
  in_stock: boolean | null;
  stock: number | null;
  requested_quantity: number;
  can_fulfill: boolean | null;
  checked_at: string;
  note?: string;
}

export async function checkStock(productId: string, quantity = 1): Promise<StockResult> {
  const url = merchantUrl(config.merchant.stockApi, productId, { _ts: Date.now() });
  const response = await callMerchant(url);

  if (response.status === 404) {
    await auditLog({
      actor: 'buyer_agent',
      action: 'check_stock',
      result: 'blocked',
      reasoning: `Stock check failed because product "${productId}" is not in the ${config.merchant.name} catalog.`,
      details: { product_id: productId },
    });
    throw new ToolError(`No product with id "${productId}" exists in this catalog.`);
  }

  if (!response.ok) {
    throw new ToolError(
      `Live stock check failed for "${productId}" (HTTP ${response.status}): ${merchantMessage(response.data, response.raw)}`,
      { product_id: productId, status: response.status },
    );
  }

  const record = unwrapObject(response.data);
  if (!record) throw new ToolError(`The merchant returned an unreadable stock response for "${productId}".`);

  const product = normalizeProduct(record);
  const canFulfill =
    product.stock !== null
      ? product.stock >= quantity
      : product.in_stock === null
        ? null
        : product.in_stock;

  const result: StockResult = {
    product_id: product.id || productId,
    name: product.name,
    in_stock: product.in_stock,
    stock: product.stock,
    requested_quantity: quantity,
    can_fulfill: canFulfill,
    checked_at: new Date().toISOString(),
    note:
      canFulfill === null
        ? 'The merchant does not publish stock levels on this endpoint. Treat availability as unconfirmed until the order is placed.'
        : undefined,
  };

  await auditLog({
    actor: 'buyer_agent',
    action: 'check_stock',
    result: canFulfill === false ? 'blocked' : 'success',
    reasoning:
      canFulfill === false
        ? `Live stock check: "${product.name}" cannot cover ${quantity} unit${quantity === 1 ? '' : 's'} right now.`
        : canFulfill === null
          ? `Live stock check for "${product.name}" returned no stock figure, so availability is unconfirmed.`
          : `Live stock check: "${product.name}" has enough stock for ${quantity} unit${quantity === 1 ? '' : 's'}.`,
    details: { product_id: result.product_id, stock: result.stock, requested_quantity: quantity },
  });

  return result;
}

export const checkStockTool: ToolDefinition = {
  name: 'check_stock',
  title: 'Check live stock',
  description:
    'Check live availability for a product. This is never cached: call it immediately before promising a customer that something is available.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product id to check.' },
      quantity: { type: 'number', description: 'How many units are needed (default 1).' },
    },
    required: ['product_id'],
    additionalProperties: false,
  },
  handler: async (args) =>
    checkStock(requireString(args, 'product_id'), optionalNumber(args, 'quantity') ?? 1),
};
