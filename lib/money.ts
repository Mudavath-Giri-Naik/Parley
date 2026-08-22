import { config } from './config';

/**
 * Parley does all of its arithmetic in minor units (paise, cents) as integers.
 * Merchant APIs may report prices in either unit, which PRICE_UNIT declares.
 */

export function toMinorUnits(price: number): number {
  const value = config.merchant.priceUnit === 'minor' ? price : price * 100;
  return Math.round(value);
}

export function toMajorUnits(minor: number): number {
  return minor / 100;
}

export function formatMoney(minor: number, currency = config.merchant.currency): string {
  const amount = toMajorUnits(minor);
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** Applies a discount percentage to a minor-unit amount, rounding in the customer's favour. */
export function applyDiscount(amountMinor: number, discountPercent: number): number {
  if (!discountPercent) return amountMinor;
  return Math.max(0, Math.round(amountMinor * (1 - discountPercent / 100)));
}

/** Parses a price out of whatever shape the merchant returned: 1499, "1499", "₹1,499.00". */
export function parsePrice(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[^0-9.-]/g, '');
    const parsed = Number.parseFloat(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
