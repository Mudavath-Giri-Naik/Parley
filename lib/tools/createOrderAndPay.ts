import { auditLog } from '../auditLog';
import { config } from '../config';
import {
  callMerchant,
  findBodyRejection,
  isMerchantOutage,
  isRecord,
  looksOutOfStock,
  merchantMessage,
  merchantUrl,
  normalizeProduct,
  unwrapObject,
  type NormalizedProduct,
} from '../merchantApi';
import { applyDiscount, formatMoney } from '../money';
import { PaymentError, createPaymentLink } from '../razorpay';
import { refundToMandate, spendAgainstMandate } from './checkMandate';
import {
  ToolError,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  type ToolDefinition,
} from './types';

/**
 * The core money action.
 *
 * Order of operations matters and is deliberate:
 *   1. Price the item from the merchant's live catalog (never from what the agent remembers).
 *   2. Clamp any discount to MAX_DISCOUNT_PERCENT here, in code.
 *   3. Ask the merchant's own order API to reserve the stock. Parley does not
 *      reimplement inventory locking; the merchant's backend owns that.
 *   4. If a mandate covers the amount, charge it and finish without a human.
 *   5. Otherwise create a payment link and stop for human approval.
 *   6. Log every outcome, including the ones that fail.
 */

export type OrderOutcome =
  | 'completed'
  | 'awaiting_approval'
  | 'blocked'
  | 'failed'
  /** The merchant's own systems errored; no decision about the product was returned. */
  | 'unavailable';

export interface OrderResult {
  outcome: OrderOutcome;
  order_id?: string;
  product: { id: string; name: string };
  quantity: number;
  list_price_minor: number;
  amount_minor: number;
  discount_percent: number;
  discount_applied: boolean;
  currency: string;
  amount_display: string;
  payment_link?: string;
  payment_link_id?: string;
  mandate?: { id: string; remaining_minor: number; remaining_display: string };
  requires_human_approval: boolean;
  message: string;
  suggestion?: string;
}

export interface CreateOrderArgs {
  product_id: string;
  customer_name: string;
  customer_email: string;
  customer_ref?: string;
  use_mandate?: boolean;
  quantity?: number;
  discount_percent?: number;
  note?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads the product without writing its own audit entry; the order entry covers it. */
async function priceProduct(productId: string): Promise<NormalizedProduct> {
  const response = await callMerchant(merchantUrl(config.merchant.stockApi, productId, { _ts: Date.now() }));
  if (response.status === 404) {
    throw new ToolError(`No product with id "${productId}" exists in this catalog.`);
  }
  if (!response.ok) {
    throw new ToolError(
      `Could not price product "${productId}" (HTTP ${response.status}): ${merchantMessage(response.data, response.raw)}`,
    );
  }
  const record = unwrapObject(response.data);
  if (!record) throw new ToolError(`The merchant returned an unreadable response for "${productId}".`);
  const product = normalizeProduct(record);
  if (!product.id) product.id = productId;
  if (product.price_minor === null) {
    throw new ToolError(
      `The merchant did not return a price for "${product.name}", so Parley will not guess one. Nothing has been charged.`,
    );
  }
  return product;
}

function extractOrderId(payload: unknown): string | undefined {
  const record = unwrapObject(payload) ?? (isRecord(payload) ? payload : null);
  if (!record) return undefined;
  for (const key of ['order_id', 'orderId', 'id', 'reference', 'reference_id', 'order_number']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

export async function createOrderAndPay(args: CreateOrderArgs): Promise<OrderResult> {
  const quantity = Math.max(1, Math.trunc(args.quantity ?? 1));
  if (!EMAIL_PATTERN.test(args.customer_email)) {
    throw new ToolError(`"${args.customer_email}" is not a valid email address.`);
  }

  // Step 1 and 2: price from the live catalog, then clamp the discount in code.
  const product = await priceProduct(args.product_id);
  const listPriceMinor = product.price_minor! * quantity;

  const requestedDiscount = args.discount_percent ?? 0;
  const cap = config.agent.maxDiscountPercent;
  const discountPercent = Math.min(Math.max(requestedDiscount, 0), cap);
  const discountWasClamped = requestedDiscount > cap;

  if (discountWasClamped) {
    await auditLog({
      actor: 'system',
      action: 'discount_clamped',
      result: 'blocked',
      reasoning:
        `A discount of ${requestedDiscount}% was requested on "${product.name}", which is above this merchant's ` +
        `maximum of ${cap}%. Parley reduced it to ${cap}% before pricing the order. The agent's own restraint is never the only safeguard.`,
      customerRef: args.customer_ref ?? args.customer_email,
      details: { product_id: product.id, requested_discount: requestedDiscount, max_discount_percent: cap },
    });
  }

  const amountMinor = applyDiscount(listPriceMinor, discountPercent);
  const currency = product.currency || config.merchant.currency;
  const customerRef = args.customer_ref ?? args.customer_email;

  // Step 3: the merchant's own backend owns stock reservation. Parley only asks.
  const orderPayload = {
    product_id: product.id,
    productId: product.id,
    quantity,
    customer_name: args.customer_name,
    customerName: args.customer_name,
    customer_email: args.customer_email,
    customerEmail: args.customer_email,
    amount: amountMinor,
    amount_minor: amountMinor,
    currency,
    discount_percent: discountPercent,
    note: args.note,
    source: 'parley',
  };

  let orderResponse;
  try {
    orderResponse = await callMerchant(config.merchant.orderApi, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayload),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await auditLog({
      actor: 'seller_agent',
      action: 'create_order_and_pay',
      result: 'failed',
      reasoning: `The order for "${product.name}" could not be placed because the merchant's order API was unreachable: ${message} Nothing was charged.`,
      customerRef,
      amountMinor,
      currency,
      details: { product_id: product.id, quantity },
    });
    return {
      outcome: 'failed',
      product: { id: product.id, name: product.name },
      quantity,
      list_price_minor: listPriceMinor,
      amount_minor: amountMinor,
      discount_percent: discountPercent,
      discount_applied: discountPercent > 0,
      currency,
      amount_display: formatMoney(amountMinor, currency),
      requires_human_approval: false,
      message: `The order could not be placed: the store's ordering system is not responding. Nothing has been charged.`,
      suggestion: 'Tell the customer honestly that the store is unreachable and offer to try again shortly.',
    };
  }

  // A 5xx means the merchant's systems failed, which is not an answer about this
  // product. Reporting it as "sold out" would be a lie about the customer's item.
  if (isMerchantOutage(orderResponse.status)) {
    const detail = merchantMessage(orderResponse.data, orderResponse.raw);
    await auditLog({
      actor: 'seller_agent',
      action: 'merchant_unavailable',
      result: 'failed',
      reasoning:
        `The order for "${product.name}" could not be placed because the store's own systems returned a server error ` +
        `(HTTP ${orderResponse.status}: ${detail}). This is an outage, not a stock decision: the item may well be available. ` +
        'Nothing was charged and no payment was requested.',
      customerRef,
      amountMinor,
      currency,
      details: { product_id: product.id, quantity, merchant_status: orderResponse.status },
    });
    return {
      outcome: 'unavailable',
      product: { id: product.id, name: product.name },
      quantity,
      list_price_minor: listPriceMinor,
      amount_minor: amountMinor,
      discount_percent: discountPercent,
      discount_applied: discountPercent > 0,
      currency,
      amount_display: formatMoney(amountMinor, currency),
      requires_human_approval: false,
      message:
        `This store's system is temporarily unavailable, so the order could not be placed and nothing was charged. ` +
        `"${product.name}" has not been reported as out of stock.`,
      suggestion:
        'Tell the customer the store is having temporary technical trouble and offer to try again shortly. Do not tell them the item is sold out: that is not what happened.',
    };
  }

  // The graceful failure case: a refusal for lack of stock is a normal answer, not a crash.
  const bodyRejection = findBodyRejection(orderResponse.data);
  if (
    !orderResponse.ok ||
    bodyRejection.rejected ||
    looksOutOfStock(orderResponse.status, orderResponse.data, orderResponse.raw)
  ) {
    const outOfStock = looksOutOfStock(orderResponse.status, orderResponse.data, orderResponse.raw);
    const detail = bodyRejection.rejected
      ? (bodyRejection.reason ?? merchantMessage(orderResponse.data, orderResponse.raw))
      : merchantMessage(orderResponse.data, orderResponse.raw);

    if (outOfStock) {
      await auditLog({
        actor: 'seller_agent',
        action: 'create_order_and_pay',
        result: 'blocked',
        reasoning:
          `The order for "${product.name}" was blocked because the store reported it is out of stock ` +
          `(${detail}). No payment was requested and nothing was charged. The customer should be told plainly and offered an alternative.`,
        customerRef,
        amountMinor,
        currency,
        details: { product_id: product.id, quantity, merchant_status: orderResponse.status },
      });
      return {
        outcome: 'blocked',
        product: { id: product.id, name: product.name },
        quantity,
        list_price_minor: listPriceMinor,
        amount_minor: amountMinor,
        discount_percent: discountPercent,
        discount_applied: discountPercent > 0,
        currency,
        amount_display: formatMoney(amountMinor, currency),
        requires_human_approval: false,
        message: `"${product.name}" is out of stock, so the order was not placed and nothing was charged.`,
        suggestion:
          'Tell the customer directly that this item is unavailable, then use search_products to offer a genuine alternative. Do not imply the order went through.',
      };
    }

    await auditLog({
      actor: 'seller_agent',
      action: 'create_order_and_pay',
      result: 'failed',
      reasoning: bodyRejection.rejected
        ? `The order for "${product.name}" was refused by the store. It answered HTTP ${orderResponse.status}, but the response body carried a rejection in "${bodyRejection.field}": ${detail}. No payment was requested and nothing was charged.`
        : `The order for "${product.name}" was rejected by the store (HTTP ${orderResponse.status}): ${detail}. Nothing was charged.`,
      customerRef,
      amountMinor,
      currency,
      details: {
        product_id: product.id,
        quantity,
        merchant_status: orderResponse.status,
        ...(bodyRejection.rejected ? { rejection_field: bodyRejection.field } : {}),
      },
    });
    return {
      outcome: 'failed',
      product: { id: product.id, name: product.name },
      quantity,
      list_price_minor: listPriceMinor,
      amount_minor: amountMinor,
      discount_percent: discountPercent,
      discount_applied: discountPercent > 0,
      currency,
      amount_display: formatMoney(amountMinor, currency),
      requires_human_approval: false,
      message: `The store could not accept this order: ${detail}. Nothing has been charged.`,
      suggestion: 'Report the reason to the customer as given. Do not invent a workaround or a policy.',
    };
  }

  const orderId = extractOrderId(orderResponse.data);

  // Step 4: a mandate is the only thing that can skip human approval.
  if (args.use_mandate) {
    if (!config.db.enabled) {
      await auditLog({
        actor: 'system',
        action: 'mandate_unavailable',
        result: 'blocked',
        reasoning:
          'A mandate purchase was requested but PARLEY_DB_URL is not configured, so no mandate can be verified. Falling back to human approval.',
        customerRef,
        details: { product_id: product.id },
      });
    } else {
      const spend = await spendAgainstMandate(customerRef, amountMinor);
      if (spend.ok && spend.mandate) {
        await auditLog({
          actor: 'seller_agent',
          action: 'create_order_and_pay',
          result: 'success',
          reasoning:
            `Order ${orderId ?? '(id not returned)'} for ${quantity} x "${product.name}" completed under the customer's standing mandate. ` +
            `${formatMoney(amountMinor, currency)} was charged against the cap, leaving ${formatMoney(spend.mandate.remaining_minor, currency)}. ` +
            'No human approval was needed because the amount was inside the limit the customer had already authorized.',
          customerRef,
          amountMinor,
          currency,
          details: {
            product_id: product.id,
            order_id: orderId,
            quantity,
            mandate_id: spend.mandate.id,
            remaining_minor: spend.mandate.remaining_minor,
            discount_percent: discountPercent,
          },
        });
        return {
          outcome: 'completed',
          order_id: orderId,
          product: { id: product.id, name: product.name },
          quantity,
          list_price_minor: listPriceMinor,
          amount_minor: amountMinor,
          discount_percent: discountPercent,
          discount_applied: discountPercent > 0,
          currency,
          amount_display: formatMoney(amountMinor, currency),
          mandate: {
            id: spend.mandate.id,
            remaining_minor: spend.mandate.remaining_minor,
            remaining_display: formatMoney(spend.mandate.remaining_minor, currency),
          },
          requires_human_approval: false,
          message:
            `Order placed and paid under the existing mandate. ${formatMoney(amountMinor, currency)} charged, ` +
            `${formatMoney(spend.mandate.remaining_minor, currency)} remaining on the cap.`,
        };
      }

      await auditLog({
        actor: 'system',
        action: 'mandate_declined',
        result: 'blocked',
        reasoning:
          `${spend.reason ?? 'The mandate could not cover this purchase.'} Parley fell back to requiring explicit human approval instead of charging.`,
        customerRef,
        amountMinor,
        currency,
        details: { product_id: product.id, order_id: orderId },
      });
    }
  }

  // Step 5: human approval via a payment link on the merchant's own account.
  if (!config.payments.enabled) {
    await auditLog({
      actor: 'seller_agent',
      action: 'create_order_and_pay',
      result: 'blocked',
      reasoning:
        `Order ${orderId ?? '(id not returned)'} for "${product.name}" was reserved, but no payment could be requested because ` +
        'this deployment has no payment keys configured. Nothing was charged.',
      customerRef,
      amountMinor,
      currency,
      details: { product_id: product.id, order_id: orderId },
    });
    return {
      outcome: 'blocked',
      order_id: orderId,
      product: { id: product.id, name: product.name },
      quantity,
      list_price_minor: listPriceMinor,
      amount_minor: amountMinor,
      discount_percent: discountPercent,
      discount_applied: discountPercent > 0,
      currency,
      amount_display: formatMoney(amountMinor, currency),
      requires_human_approval: true,
      message:
        'The item was reserved but this store cannot take payment right now, so nothing was charged.',
      suggestion: 'Tell the customer the order is held but payment is unavailable, and do not claim it is paid.',
    };
  }

  try {
    const link = await createPaymentLink({
      amountMinor,
      description: `${quantity} x ${product.name} from ${config.merchant.name}`,
      customerName: args.customer_name,
      customerEmail: args.customer_email,
      referenceId: orderId ? `${orderId}-${Date.now()}` : undefined,
      notes: { product_id: product.id, customer_ref: customerRef },
    });

    await auditLog({
      actor: 'seller_agent',
      action: 'create_order_and_pay',
      result: 'pending',
      reasoning:
        `Order ${orderId ?? '(id not returned)'} for ${quantity} x "${product.name}" was reserved and a payment link for ` +
        `${formatMoney(amountMinor, currency)} was issued. This purchase is waiting on the customer to approve and pay in person, ` +
        'because no mandate covered it.',
      customerRef,
      amountMinor,
      currency,
      details: {
        product_id: product.id,
        order_id: orderId,
        quantity,
        payment_link_id: link.id,
        discount_percent: discountPercent,
      },
    });

    return {
      outcome: 'awaiting_approval',
      order_id: orderId,
      product: { id: product.id, name: product.name },
      quantity,
      list_price_minor: listPriceMinor,
      amount_minor: amountMinor,
      discount_percent: discountPercent,
      discount_applied: discountPercent > 0,
      currency,
      amount_display: formatMoney(amountMinor, currency),
      payment_link: link.short_url,
      payment_link_id: link.id,
      requires_human_approval: true,
      message:
        `The order is reserved and waiting for payment. Give the customer this link to approve and pay ` +
        `${formatMoney(amountMinor, currency)}: ${link.short_url}`,
      suggestion:
        'Share the payment link with the customer and make clear the purchase is not complete until they pay.',
    };
  } catch (err) {
    if (args.use_mandate) await refundToMandate(customerRef, amountMinor);
    const message = err instanceof PaymentError ? err.message : String(err);
    await auditLog({
      actor: 'seller_agent',
      action: 'create_order_and_pay',
      result: 'failed',
      reasoning: `Order ${orderId ?? '(id not returned)'} for "${product.name}" was reserved but the payment link could not be created: ${message} Nothing was charged.`,
      customerRef,
      amountMinor,
      currency,
      details: { product_id: product.id, order_id: orderId },
    });
    return {
      outcome: 'failed',
      order_id: orderId,
      product: { id: product.id, name: product.name },
      quantity,
      list_price_minor: listPriceMinor,
      amount_minor: amountMinor,
      discount_percent: discountPercent,
      discount_applied: discountPercent > 0,
      currency,
      amount_display: formatMoney(amountMinor, currency),
      requires_human_approval: true,
      message: `Payment could not be set up: ${message} Nothing has been charged.`,
      suggestion: 'Be honest that payment setup failed and offer to try again.',
    };
  }
}

export const createOrderAndPayTool: ToolDefinition = {
  name: 'create_order_and_pay',
  title: 'Create order and take payment',
  description:
    'Place a real order with the merchant and either charge it against the customer\'s existing spend mandate or return a payment link for the customer to approve. Discounts above the merchant\'s configured maximum are reduced automatically. Confirm the item and the price with the customer before calling this.',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product to buy.' },
      customer_name: { type: 'string', description: "The customer's full name." },
      customer_email: { type: 'string', description: "The customer's email address." },
      customer_ref: {
        type: 'string',
        description: 'Stable customer identifier used for mandates. Defaults to the email address.',
      },
      use_mandate: {
        type: 'boolean',
        description:
          'Set true to charge an existing spend mandate and skip human approval. Falls back to a payment link if the mandate does not cover the amount.',
      },
      quantity: { type: 'number', description: 'How many units (default 1).' },
      discount_percent: {
        type: 'number',
        description:
          'Discount agreed during negotiation. Clamped to the merchant\'s maximum server-side, so requesting more is never an error, just capped.',
      },
      note: { type: 'string', description: 'Anything the merchant should see on the order.' },
    },
    required: ['product_id', 'customer_name', 'customer_email'],
    additionalProperties: false,
  },
  handler: async (args) =>
    createOrderAndPay({
      product_id: requireString(args, 'product_id'),
      customer_name: requireString(args, 'customer_name'),
      customer_email: requireString(args, 'customer_email'),
      customer_ref: optionalString(args, 'customer_ref'),
      use_mandate: optionalBoolean(args, 'use_mandate'),
      quantity: optionalNumber(args, 'quantity'),
      discount_percent: optionalNumber(args, 'discount_percent'),
      note: optionalString(args, 'note'),
    }),
};
