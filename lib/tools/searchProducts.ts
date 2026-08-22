import { auditLog } from '../auditLog';
import { config } from '../config';
import {
  callMerchant,
  merchantMessage,
  merchantUrl,
  normalizeProduct,
  unwrapList,
  type NormalizedProduct,
} from '../merchantApi';
import { formatMoney } from '../money';
import {
  ToolError,
  optionalNumber,
  optionalString,
  requireString,
  type ToolDefinition,
} from './types';

/**
 * Calls MERCHANT_SEARCH_API and returns one standard product shape regardless of
 * what the merchant's own API calls its fields.
 */

export interface SearchArgs {
  query: string;
  size?: string;
  color?: string;
  max_price?: number;
  limit?: number;
}

export async function searchProducts(args: SearchArgs): Promise<{
  query: string;
  count: number;
  products: NormalizedProduct[];
  note?: string;
}> {
  const url = merchantUrl(config.merchant.searchApi, undefined, {
    q: args.query,
    query: args.query,
    search: args.query,
    size: args.size,
    color: args.color,
    max_price: args.max_price,
  });

  const response = await callMerchant(url);
  if (!response.ok) {
    throw new ToolError(
      `The catalog search failed (HTTP ${response.status}): ${merchantMessage(response.data, response.raw)}`,
      { status: response.status },
    );
  }

  const records = unwrapList(response.data);
  let products = records.map(normalizeProduct).filter((product) => product.id || product.name);

  // The merchant may or may not honour the filters as query parameters, so Parley
  // applies them again locally. Filtering twice is harmless; filtering never is not.
  if (args.size) {
    const wanted = args.size.toLowerCase();
    products = products.filter(
      (p) => !p.size || p.size.toLowerCase().split(/[,\s/|]+/).includes(wanted),
    );
  }
  if (args.color) {
    const wanted = args.color.toLowerCase();
    products = products.filter((p) => !p.color || p.color.toLowerCase().includes(wanted));
  }
  if (args.max_price !== undefined) {
    const capMinor = Math.round(args.max_price * 100);
    products = products.filter((p) => p.price_minor === null || p.price_minor <= capMinor);
  }

  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 50);
  const limited = products.slice(0, limit);

  await auditLog({
    actor: 'buyer_agent',
    action: 'search_products',
    result: 'success',
    reasoning:
      `Searched the ${config.merchant.name} catalog for "${args.query}"` +
      `${args.size ? ` in size ${args.size}` : ''}` +
      `${args.color ? ` in ${args.color}` : ''}` +
      `${args.max_price !== undefined ? ` under ${formatMoney(Math.round(args.max_price * 100))}` : ''}` +
      ` and found ${limited.length} matching product${limited.length === 1 ? '' : 's'}.`,
    details: { query: args.query, filters: { size: args.size, color: args.color, max_price: args.max_price }, returned: limited.length },
  });

  return {
    query: args.query,
    count: limited.length,
    products: limited,
    note:
      limited.length === 0
        ? 'No products matched. Try a broader query or relax the filters before telling the customer nothing exists.'
        : undefined,
  };
}

export const searchProductsTool: ToolDefinition = {
  name: 'search_products',
  title: 'Search products',
  description:
    "Search the merchant's live product catalog. Returns a normalized list of products with ids, names, prices in minor units, and stock where the merchant exposes it. Always search before quoting a price.",
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the customer is looking for, in their own words.' },
      size: { type: 'string', description: 'Optional size filter, e.g. "M".' },
      color: { type: 'string', description: 'Optional color filter.' },
      max_price: {
        type: 'number',
        description: 'Optional maximum price, in major units (e.g. 1500 means 1500 rupees).',
      },
      limit: { type: 'number', description: 'Maximum products to return (1-50, default 20).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args) =>
    searchProducts({
      query: requireString(args, 'query'),
      size: optionalString(args, 'size'),
      color: optionalString(args, 'color'),
      max_price: optionalNumber(args, 'max_price'),
      limit: optionalNumber(args, 'limit'),
    }),
};
