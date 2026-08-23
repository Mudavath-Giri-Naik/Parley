# Known limitations

Parley was built against a single real storefront, then audited twice for coupling to it.
Everything below is a known, unfixed gap. Findings that have been fixed are not listed.

← [Back to the README](../README.md)

---


Parley was built and hardened against a single real storefront, then audited twice for coupling to it. Everything below is a known, unfixed gap. Two audit findings have already been fixed and are not repeated here.

## Will bite you

**Common stock field names are missing from the alias table.** `stock_quantity` (WooCommerce), `inventory_quantity` (Shopify, Medusa) and `inventory_level` (BigCommerce) are not recognised. *If your stock field is not one we recognise, set `FIELD_MAP` or every product reports unknown availability and your agent refuses to promise anything is in stock.*

**Unusual response envelopes are not configurable, and fail silently.** The list of recognised wrappers is fixed. *If your catalog sits under something else — `{"katalog":{"treffer":[…]}}` — you get `count: 0` and an agent politely telling customers you have nothing, with no error anywhere. If your catalog looks empty on the status page, check this first.*

**A failed payment link can wipe a mandate's recorded spend.** When a mandated purchase is declined for exceeding the cap and the fallback payment link then fails, the full attempted amount is refunded against the mandate even though it was never charged, clamped at zero. *A customer's legitimate earlier spend can be erased from their cap, handing back headroom they had already used.* `npm run test:regression` fails on this deliberately.

## Worth knowing

**`size` and `color` are first-class everywhere.** They are canonical fields and `search_products` parameters. *If you sell books or electronics your agent is offered irrelevant filters, and there is no way to add `author` or `capacity`.*

**`FIELD_MAP` only maps those ten fields.** *A `status` field, order-id fields and order-status fields cannot be renamed.*

**The alias table is a fallback even when you map a field.** A mapped field missing from *some* records silently falls through to an alias. *Map `price` to `net_price` and a record carrying only a gross `price` is priced from the wrong one rather than rejected.*

**In-stock detection is hardcoded English.** `OUT_OF_STOCK_PATTERN` configures the negative side only; the positive side tests for `in stock` / `available`. *A non-English catalog can say "sold out" but not "available".*

**Currency formatting is hardcoded to the `en-IN` locale.** *A US merchant sees `$12,34,567.89` rather than `$1,234,567.89`. Amounts are correct; digit grouping is not.*

**Every currency is assumed to have exactly two decimal places.** *JPY (zero) and KWD (three) are mispriced by 100× and 10×.*

**Payments are Razorpay only.** `lib/razorpay.ts` is one self-contained module behind a small interface, so another provider is a file rather than a refactor — but nothing else is implemented.

**Payment completion is not wired to a webhook.** An unmandated purchase returns a link and is logged `pending`; Parley never hears that it was paid. *Reconcile with `check_order_status` — a `pending` row does not mean unpaid.*

## Minor

- **`409` and `410` always mean out of stock**, and are not configurable. *If you use `409` for idempotency conflicts, those are reported to customers as sold out.*
- **Order-id and order-status field names are not configurable.** *An `orderRef` or a `shipping_state` will not be found.*
- **Search sends `q`, `query` and `search` together, plus a `_ts` cache-buster; orders send both snake_case and camelCase.** *An API that rejects unknown query parameters or body fields will 400.*
- **`.env.example` ships `PRICE_UNIT=minor` while the code default is `major`.** *Delete the line and behaviour changes. Always set it explicitly.*
- **`mrp` and `price_inr` in the price aliases are India-specific.** Harmless, but not universal.
- **Mandates cannot be revoked through a tool.** They expire and they exhaust; withdrawing one early means a row update in your own database.
- **One active mandate per customer**, enforced by a partial unique index.
- **`negotiate_with_seller` is stateless between calls.** Each message starts a fresh conversation; the buyer agent holds the thread.

---
