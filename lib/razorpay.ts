import { config } from './config';

/**
 * Razorpay Payment Links, used as the human-approval step. Parley never handles a
 * card number: it creates a link with the merchant's own keys and hands back the URL,
 * so the customer completes payment on Razorpay's own hosted page.
 */

const API = 'https://api.razorpay.com/v1/payment_links';

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

export interface PaymentLink {
  id: string;
  short_url: string;
  amount_minor: number;
  currency: string;
  status: string;
  reference_id?: string;
  expires_at?: string;
}

export interface CreatePaymentLinkInput {
  amountMinor: number;
  description: string;
  customerName: string;
  customerEmail: string;
  referenceId?: string;
  notes?: Record<string, string>;
}

/** Razorpay rejects a reference_id longer than this. */
const MAX_REFERENCE_LENGTH = 40;

/**
 * Builds a reference the payment provider will accept.
 *
 * The merchant's order id is whatever their system produces, and a UUID plus a
 * timestamp overruns the limit — so the length is enforced here, in the adapter
 * that knows the provider's rules, rather than trusted to every caller.
 *
 * The tail is a base-36 timestamp so a retried order gets a fresh reference: the
 * provider rejects a duplicate, and an order that failed once must still be payable.
 * The order id keeps the leading characters, which is what makes a payment
 * recognisable when reconciling against the merchant's own records.
 */
export function buildReferenceId(orderId?: string): string | undefined {
  if (!orderId) return undefined;

  const suffix = Date.now().toString(36);
  const safeOrderId = orderId.replace(/[^A-Za-z0-9._-]/g, '');
  const room = MAX_REFERENCE_LENGTH - suffix.length - 1;

  if (room <= 0) return suffix.slice(0, MAX_REFERENCE_LENGTH);
  return `${safeOrderId.slice(0, room)}-${suffix}`;
}

export async function createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink> {
  if (!config.payments.enabled) {
    throw new PaymentError(
      'Payments are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable the approval-and-pay step.',
    );
  }

  const auth = Buffer.from(
    `${config.payments.razorpayKeyId}:${config.payments.razorpayKeySecret}`,
  ).toString('base64');

  const body: Record<string, unknown> = {
    amount: Math.round(input.amountMinor),
    currency: config.merchant.currency,
    accept_partial: false,
    description: input.description.slice(0, 2048),
    customer: {
      name: input.customerName,
      email: input.customerEmail,
    },
    notify: { email: true, sms: false },
    reminder_enable: true,
    notes: {
      source: 'parley',
      merchant: config.merchant.name,
      ...(input.notes ?? {}),
    },
  };
  const reference = buildReferenceId(input.referenceId);
  if (reference) body.reference_id = reference;
  if (config.payments.callbackUrl) {
    body.callback_url = config.payments.callbackUrl;
    body.callback_method = 'get';
  }

  let response: Response;
  try {
    response = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (err) {
    throw new PaymentError(
      `Could not reach the payment provider: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // fall through to the error path below
  }

  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    const description =
      (error?.description as string | undefined) ?? raw.slice(0, 300) ?? 'Unknown payment error.';
    throw new PaymentError(`The payment provider rejected the request: ${description}`, {
      status: response.status,
    });
  }

  return {
    id: String(payload.id ?? ''),
    short_url: String(payload.short_url ?? ''),
    amount_minor: Number(payload.amount ?? input.amountMinor),
    currency: String(payload.currency ?? config.merchant.currency),
    status: String(payload.status ?? 'created'),
    reference_id: payload.reference_id ? String(payload.reference_id) : undefined,
    expires_at: payload.expire_by ? new Date(Number(payload.expire_by) * 1000).toISOString() : undefined,
  };
}
