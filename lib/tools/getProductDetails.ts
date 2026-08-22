import { auditLog } from '../auditLog';
import { config } from '../config';
import {
  callMerchant,
  merchantMessage,
  merchantUrl,
  normalizeProduct,
  unwrapObject,
  type NormalizedProduct,
} from '../merchantApi';
import { ToolError, requireString, type ToolDefinition } from './types';

/** Fetches one product from MERCHANT_STOCK_API and normalizes it. */

export async function getProductDetails(productId: string): Promise<NormalizedProduct> {
  const url = merchantUrl(config.merchant.stockApi, productId);
  const response = await callMerchant(url);

  if (response.status === 404) {
    await auditLog({
      actor: 'buyer_agent',
      action: 'get_product_details',
      result: 'blocked',
      reasoning: `Product "${productId}" does not exist in the ${config.merchant.name} catalog, so no details could be returned.`,
      details: { product_id: productId },
    });
    throw new ToolError(`No product with id "${productId}" exists in this catalog.`, {
      product_id: productId,
    });
  }

  if (!response.ok) {
    throw new ToolError(
      `Could not load product "${productId}" (HTTP ${response.status}): ${merchantMessage(response.data, response.raw)}`,
      { product_id: productId, status: response.status },
    );
  }

  const record = unwrapObject(response.data);
  if (!record) {
    throw new ToolError(`The merchant returned an unreadable response for product "${productId}".`);
  }

  const product = normalizeProduct(record);
  if (!product.id) product.id = productId;

  await auditLog({
    actor: 'buyer_agent',
    action: 'get_product_details',
    result: 'success',
    reasoning: `Looked up full details for "${product.name}" (${product.id}) so the customer could be quoted accurately.`,
    amountMinor: product.price_minor,
    details: { product_id: product.id, in_stock: product.in_stock },
  });

  return product;
}

export const getProductDetailsTool: ToolDefinition = {
  name: 'get_product_details',
  title: 'Get product details',
  description:
    'Fetch the full, live record for a single product by id: name, price, description, and stock. Use this before offering a price or placing an order.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product id returned by search_products.' },
    },
    required: ['product_id'],
    additionalProperties: false,
  },
  handler: async (args) => getProductDetails(requireString(args, 'product_id')),
};
