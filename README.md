<div align="center">

# Parley

**Your storefront, negotiating for itself.**

A self-hostable template that turns any merchant's existing e-commerce APIs into an AI seller agent — one that any external buyer agent (Claude, ChatGPT, Gemini) can discover, negotiate with, and buy from, within limits you set and with every decision on the record.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMudavath-Giri-Naik%2FParley&env=MERCHANT_NAME,MERCHANT_SEARCH_API,MERCHANT_STOCK_API,MERCHANT_ORDER_API,RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET,PARLEY_DB_URL,MAX_DISCOUNT_PERCENT,AGENT_PERSONA,SPEND_CAP_DEFAULT&envDescription=Point%20Parley%20at%20your%20own%20storefront%20APIs%20and%20payment%20keys&envLink=https%3A%2F%2Fgithub.com%2FMudavath-Giri-Naik%2FParley%232-what-parley-adapts-to-automatically)

`Next.js` · `MCP over Streamable HTTP` · `Postgres` · `Razorpay` · `Claude or Gemini` · `MIT`

</div>

---

Your customers have started shopping with AI agents. Those agents can read your website, badly. They cannot check whether the last one in your size is still there, they cannot ask you for a better price, and they certainly cannot pay you.

Parley is the other answer to that: **you run your own seller agent.** It sits in front of the APIs you already have, speaks the Model Context Protocol so any AI agent can connect, and does business inside limits you define. You deploy your own copy, with your own keys, on your own infrastructure. The Parley project never sees your credentials, your catalog, or your customers.

**New here? Read [section 1](#1-what-your-store-must-provide) first.** It is the only part you cannot configure your way around.

## How it works

```
   Customer                Their AI agent            YOUR deployment              Your existing store
  ──────────              ───────────────           ─────────────────            ────────────────────

  "find me a               Claude / ChatGPT   ──▶    /.well-known/                 
   navy tee under          / Gemini, acting          agent-commerce.json          
   ₹1500, buy it           for the customer          (how to connect)             
   if it's in stock"                │                                             
                                    │                                             
                                    ▼                                             
                              MCP: /api/mcp   ◀──▶   search_products      ──────▶  GET  /your/products
                              Streamable HTTP        check_stock (live)   ──────▶  GET  /your/products/:id
                                    │                negotiate_with_seller          
                                    │                create_order_and_pay ──────▶  POST /your/orders
                                    │                       │                        (your stock lock,
                                    │                       │                         your pipeline)
                                    │                       ▼                        
                                    │                 ┌───────────────┐              
                                    │                 │ mandate?      │              
                                    │                 ├───────────────┤              
                                    │            yes  │ within cap    │  no          
                                    │           ┌─────┴───────────────┴─────┐        
                                    │           ▼                           ▼        
                                    │      charge it,                 payment link,  
                                    │      no human needed            human approves 
                                    │           └─────────────┬─────────────┘        
                                    ▼                         ▼                      
                              honest answer            audit_log ──▶ /dashboard      
                                                    (what happened, and why)         
```

Four properties hold no matter what any agent says or does:

| Guarantee | How it is actually enforced |
|---|---|
| **Stock is never stale** | `check_stock` hits your API live on every call, with `cache: 'no-store'`. Nothing memoizes it. |
| **Discounts have a ceiling** | `create_order_and_pay` clamps the discount to `MAX_DISCOUNT_PERCENT` in code, when it prices the order. A silver-tongued buyer agent gets the cap, not the discount it asked for. |
| **Spending has a limit** | A purchase completes unattended only against a mandate the customer authorized. The cap is enforced by a conditional `UPDATE` in Postgres, so two concurrent orders cannot both slip under the same remaining balance. |
| **Nothing happens off the record** | Every search, stock check, mandate decision, order, refusal, and failure writes an `audit_log` row with plain-language reasoning, before the caller gets its answer. |

The seller agent's system prompt asks it to behave well. That is not the safeguard. The safeguard is the code — which is why the caps live in `lib/tools/createOrderAndPay.ts` and in the database, not in the prompt.

---

# 1. What your store must provide

**This section is the fixed part of the deal.** Everything in [section 2](#2-what-parley-adapts-to-automatically) bends to fit your API; the requirements below do not. If your store cannot do these things, Parley cannot sell for you until it can.

## 1.1 Three HTTP endpoints

Parley refuses to start without all three. They are validated at boot, and a missing one is reported on your status page and to any agent that connects.

| You must provide | Method | Parley uses it for |
|---|---|---|
| `MERCHANT_SEARCH_API` | `GET` | Browsing the catalog. Must return a list of products. |
| `MERCHANT_STOCK_API` | `GET` | One product: full details **and** every live stock check. |
| `MERCHANT_ORDER_API` | `POST` | Creating an order and reserving stock. |

All three must be absolute `http(s)` URLs. They may live on the same host, on different hosts, or behind an API gateway — Parley does not care.

**Addressing a single product.** For the two `GET` endpoints Parley needs to put a product id into the URL. It does that one of two ways:

```bash
# If the URL contains {id}, the id is substituted there:
MERCHANT_STOCK_API=https://yourstore.example.com/api/products/{id}/detail
#   → https://yourstore.example.com/api/products/SKU-1/detail

# If it does not, the id is appended as a path segment:
MERCHANT_STOCK_API=https://yourstore.example.com/api/products
#   → https://yourstore.example.com/api/products/SKU-1
```

**What search receives.** Parley appends the customer's query under three names, because merchants disagree about which one it is, plus any filters the customer gave:

```
GET {MERCHANT_SEARCH_API}?q=navy+tee&query=navy+tee&search=navy+tee&size=M&color=navy&max_price=1500
```

Read whichever you support and ignore the rest. `max_price` is in **major** units (rupees, dollars), not minor. If your endpoint ignores the filters entirely that is fine — Parley applies size, colour and price filters again to the results it gets back.

## 1.2 The order contract

This is the part worth reading twice, because it is where money moves.

### What Parley sends

A single `POST` with a JSON body. Every field is sent on every request:

```jsonc
{
  "product_id":       "SKU-1",           // the id your catalog returned
  "productId":        "SKU-1",           // same value, camelCase
  "quantity":         1,                 // integer, always >= 1
  "customer_name":    "Ada Lovelace",
  "customerName":     "Ada Lovelace",    // same value, camelCase
  "customer_email":   "ada@example.com",
  "customerEmail":    "ada@example.com", // same value, camelCase
  "amount":           149900,            // MINOR units, after any discount
  "amount_minor":     149900,            // same value
  "currency":         "INR",
  "discount_percent": 10,                // already clamped to your ceiling
  "note":             "gift wrap",       // optional; omitted when not given
  "source":           "parley"           // constant, so you can identify the channel
}
```

Snake_case and camelCase are both sent deliberately, so most backends need no adapter at all. Read whichever spelling you prefer.

> **`amount` is authoritative and already final.** It is priced from your own live catalog and has the discount ceiling applied. Do not re-derive the price from your database and charge that instead — if you do, a negotiated discount silently vanishes.

> **Your backend owns the stock lock.** Parley does not reserve inventory, does not hold a cart, and does not retry. It asks once and believes your answer. Whatever concurrency control you already have is the concurrency control.

### What Parley expects back on success

Return **HTTP 2xx**. Parley then looks for an order id, trying these keys in order, at the top level or inside a `data` / `order` / `result` / `product` / `item` wrapper:

```
order_id → orderId → id → reference → reference_id → order_number
```

A minimal acceptable success response:

```jsonc
{ "order_id": "ORD-10231" }
```

An id is strongly recommended but not fatal — without one the order still proceeds and the audit log records `(id not returned)`, which makes `check_order_status` useless for that order.

### How to refuse an order

Parley must be able to tell the difference between *"yes"*, *"no, we are out of stock"*, and *"our systems are broken"*. It reads these signals, in this order:

| Your response | Parley concludes | Outcome |
|---|---|---|
| **5xx**, any body | Your systems are down. No decision about the product was made. | `unavailable` — customer told to try again shortly, and **never** told the item is sold out |
| **409** or **410** | Out of stock | `blocked` — customer told it is unavailable, agent offers an alternative |
| Body matching `OUT_OF_STOCK_PATTERN` (2xx/4xx only) | Out of stock | `blocked` |
| Other **4xx**, or a body-level refusal (see [1.3](#13-if-your-api-returns-http-200-even-when-it-refuses)) | You refused for some other reason | `failed` — your message relayed to the customer verbatim |
| **2xx** with no refusal signal | Accepted | Proceeds to payment |

The cleanest way to say "sold out":

```jsonc
// HTTP 409
{ "ok": false, "error": "out_of_stock", "message": "This item is sold out." }
```

In every refusal case **nothing is charged and no payment is requested.** A refusal is a normal answer, not an error — Parley logs it, tells the customer honestly, and moves on.

## 1.3 If your API returns HTTP 200 even when it refuses

Plenty of APIs answer *"no"* with a `200` and a flag in the body. Left unhandled that is the most dangerous shape there is, because a refused order looks identical to an accepted one and the customer is charged for something you never agreed to sell.

Parley therefore inspects the response body before treating an order as placed. You tell it which fields carry that answer.

**Before** — your API refuses, but only in the body:

```http
HTTP/1.1 200 OK

{ "ok": false, "error": "payment_declined", "message": "Card issuer declined." }
```

`ok` and `error` are both in the defaults, so **this already works** with no configuration. Parley reads it as refused, requests no payment, and returns:

> *"The store could not accept this order: the merchant returned ok=false. Nothing has been charged."*

**After** — now suppose your API uses its own vocabulary:

```http
HTTP/1.1 200 OK

{ "accepted": false, "failure_reason": "Card issuer declined." }
```

Neither field is a default, so Parley would read this as a **successful order** and charge the customer. Tell it your names:

```bash
ORDER_SUCCESS_FIELDS=accepted,ok,success
ORDER_ERROR_FIELDS=failure_reason,error,errors
```

The two lists mean different things, and the distinction matters:

- **`ORDER_SUCCESS_FIELDS`** — refuses when the field is exactly `false`, `"false"`, or `0`. `true` means accepted.
- **`ORDER_ERROR_FIELDS`** — refuses when the field carries real content. Deliberately **not** refusals: `null`, `""`, `[]`, `{}`. If your API always includes an empty `"error": ""` slot, it will still sell.

Defaults, verbatim from `lib/config.ts`:

```bash
ORDER_SUCCESS_FIELDS=ok,success,succeeded,is_success,isSuccess
ORDER_ERROR_FIELDS=error,errors,error_code,errorCode,error_message,errorMessage,failure,fault
```

Only the **top level** of the response is inspected. A refusal buried at `data.result.error` will not be seen — hoist it, or return a non-2xx status.

## 1.4 If your store has no order endpoint

Then you need to build one. There is no way around this, and it is deliberate.

Parley will not write to your database, will not reimplement your stock locking, and will not invent an order pipeline beside the one you already run. Every write goes through your own API so that your existing validation, inventory rules, tax logic, fulfilment hooks and audit requirements all still apply. An agent-driven order should be indistinguishable from any other order in your system.

Practically, a thin endpoint is enough: accept the body in [1.2](#what-parley-sends), do whatever you already do when a human checks out, and return an order id or a refusal.

**Browsing without selling.** All four required variables must be set even if you only want the catalog tools — but `MERCHANT_ORDER_API` may point at an endpoint that always refuses. Agents can then search and check stock, and every purchase attempt is cleanly declined.

---

# 2. What Parley adapts to automatically

**Your API does not have to look like anyone else's.** This section is how you describe yours. Everything here is an environment variable — there is no config file to edit and no code to fork.

Copy `.env.example` to `.env.local` and work through it. Anything Parley cannot make sense of is reported on your status page and to any agent that connects, rather than failing silently.

## 2.1 Required

| Variable | What it controls |
|---|---|
| `MERCHANT_NAME` | Your business name. Appears in the agent's prompt, the discovery document, the dashboard and the browser title. |
| `MERCHANT_SEARCH_API` | Catalog search. See [1.1](#11-three-http-endpoints). |
| `MERCHANT_STOCK_API` | One product, for details and live stock. See [1.1](#11-three-http-endpoints). |
| `MERCHANT_ORDER_API` | Order creation. See [1.2](#12-the-order-contract). |

## 2.2 The shape of your catalog

Parley speaks ten canonical product fields: `id`, `name`, `price`, `stock`, `currency`, `description`, `image`, `url`, `size`, `color`.

**Envelopes are unwrapped automatically.** A list is found under `products`, `items`, `data`, `results`, `records` or `rows`, including one level of nesting — so `{"data":{"products":[…]}}` works. A single product is found under `product`, `item`, `data`, `result` or `order`, or as a bare object.

**Field names are guessed before you have to configure anything.** For each canonical field these aliases are tried, case-insensitively:

| Canonical | Recognised without configuration |
|---|---|
| `id` | `id`, `product_id`, `productId`, `sku`, `slug`, `handle`, `_id`, `uuid` |
| `name` | `name`, `title`, `product_name`, `productName`, `label` |
| `price` | `price`, `cost`, `amount`, `price_inr`, `unit_price`, `unitPrice`, `mrp`, `sale_price` |
| `stock` | `stock`, `qty`, `quantity`, `inventory`, `stock_count`, `stockCount`, `available_qty`, `units` |
| `currency` | `currency`, `currency_code`, `currencyCode` |
| `description` | `description`, `desc`, `details`, `summary`, `body` |
| `image` | `image`, `image_url`, `imageUrl`, `thumbnail`, `img`, `photo` |
| `url` | `url`, `link`, `permalink`, `product_url`, `productUrl` |
| `size` | `size`, `sizes`, `variant_size` |
| `color` | `color`, `colour`, `variant_color` |

Availability is also read from a boolean `in_stock`, `inStock`, `available` or `is_available` when no numeric stock is present.

> **Check this list against your API before assuming it works.** It does not cover every platform — notably `stock_quantity` (WooCommerce), `inventory_quantity` (Shopify, Medusa) and `inventory_level` (BigCommerce) are **not** recognised. See [section 3](#3-known-limitations).

### `FIELD_MAP` — when the guesses are wrong

**Default:** unset. **Format:** JSON object of `{parleyField: yourField}`.

**Before** — your catalog uses its own vocabulary:

```jsonc
{ "artikelnummer": "ART-001", "bezeichnung": "Wollmantel",
  "nettopreis": 24999, "lagerbestand": 4 }
```

Nothing matches an alias, so every product comes back as `id: ""`, `name: "Unnamed product"`, `price_minor: null`. The catalog looks broken.

**After:**

```bash
FIELD_MAP={"id":"artikelnummer","name":"bezeichnung","price":"nettopreis","stock":"lagerbestand"}
```

```jsonc
{ "id": "ART-001", "name": "Wollmantel", "price_minor": 24999,
  "price_display": "EUR 249.99", "stock": 4, "in_stock": true }
```

Only map what needs mapping — a partial map is fine, and unmapped fields keep using the alias table. Invalid keys are rejected at boot with a message naming the ten valid ones.

## 2.3 Money

| Variable | Default | What it controls |
|---|---|---|
| `PRICE_UNIT` | `major` | Whether your API's prices are whole units or the smallest unit. |
| `CURRENCY` | `INR` | ISO code used for payment and display. Uppercased automatically. |

**`PRICE_UNIT` is the single most expensive thing to get wrong.** Parley does all arithmetic in minor units.

| Your API returns | `PRICE_UNIT=major` | `PRICE_UNIT=minor` |
|---|---|---|
| `1499` | ₹1,499.00 ✅ if you store rupees | ₹14.99 ❌ |
| `149900` | ₹1,49,900.00 ❌ | ₹1,499.00 ✅ if you store paise |

Get it backwards and **every order is mispriced by a factor of 100**, in whichever direction hurts. Check one real product on your local status page before deploying.

## 2.4 Stock and refusal signals

| Variable | Default | What it controls |
|---|---|---|
| `OUT_OF_STOCK_PATTERN` | `out[_\s-]?of[_\s-]?stock`, `sold[_\s-]?out`, `insufficient[_\s-]?stock`, `no[_\s-]?stock`, `unavailable` (alternation) | Regex identifying an out-of-stock refusal. |
| `ORDER_SUCCESS_FIELDS` | `ok,success,succeeded,is_success,isSuccess` | Body fields meaning "accepted". See [1.3](#13-if-your-api-returns-http-200-even-when-it-refuses). |
| `ORDER_ERROR_FIELDS` | `error,errors,error_code,errorCode,error_message,errorMessage,failure,fault` | Body fields carrying a refusal. See [1.3](#13-if-your-api-returns-http-200-even-when-it-refuses). |

`OUT_OF_STOCK_PATTERN` is matched case-insensitively against the raw response body, and **only on 2xx/4xx replies** — a 5xx is always an outage. It is also used when your catalog reports availability as a word rather than a number.

**Before** — your API says `"warenzustand": "ausverkauft"` and you have mapped `stock` to it. The English default does not match, so availability comes back unknown.

**After:**

```bash
OUT_OF_STOCK_PATTERN=ausverkauft|nicht verfügbar|vergriffen
```

Note the asymmetry: this configures the *out-of-stock* side only. The in-stock side is a hardcoded English test — see [section 3](#3-known-limitations).

## 2.5 The limits your agent works within

| Variable | Default | What it controls |
|---|---|---|
| `MAX_DISCOUNT_PERCENT` | `10` | Hard ceiling on any discount, enforced in code when the order is priced. `0` disables discounting. Accepts 0–100. |
| `AGENT_PERSONA` | `Friendly, concise, never pushy` | How your agent comes across. Free text, dropped into the system prompt. |
| `SPEND_CAP_DEFAULT` | `500000` | Default cap for a new mandate, in **minor** units. `500000` = ₹5,000.00. |
| `MANDATE_TTL_DAYS` | `30` | How long a new mandate stays valid. Accepts 1–3650. |

A request above the ceiling is **reduced, not rejected**: ask for 50% against a 10% cap and the order is priced at 10%, with a `discount_clamped` row in the audit log naming who tried.

## 2.6 Storage and payments

| Variable | Default | What it controls |
|---|---|---|
| `PARLEY_DB_URL` | unset | Postgres for Parley's own `audit_log` and `mandates` tables. |
| `PARLEY_DB_SSL_STRICT` | `false` | Set `true` to verify the database's TLS certificate chain. |
| `RAZORPAY_KEY_ID` | unset | Your Razorpay key. Test keys start with `rzp_test_`. |
| `RAZORPAY_KEY_SECRET` | unset | Your Razorpay secret. Must be set together with the key id. |
| `PAYMENT_CALLBACK_URL` | unset | Where Razorpay returns the customer after paying. |

Without `PARLEY_DB_URL` Parley still runs: decisions go to the server log instead of the dashboard, and spend mandates are unavailable, so every purchase needs human approval. Without the Razorpay pair, orders are placed but no payment can be requested.

## 2.7 The conversational seller agent

Optional. Without a provider key the MCP tools all still work — a buyer agent can browse, check stock and transact; it just has nobody to haggle with.

| Variable | Default | What it controls |
|---|---|---|
| `AGENT_PROVIDER` | `auto` | `auto`, `anthropic` or `gemini`. `auto` uses whichever key is set, preferring Anthropic when both are. |
| `ANTHROPIC_API_KEY` | unset | Enables the agent on Anthropic. |
| `AGENT_MODEL` | `claude-opus-5` | Anthropic model. |
| `GEMINI_API_KEY` | unset | Enables the agent on Google Gemini. Modern `AQ…` keys work natively. |
| `GEMINI_MODEL` | `gemini-3.7-flash` | Gemini model. |
| `GEMINI_MAX_ATTEMPTS` | `4` | Retries when a Gemini model is busy. Daily quota errors are not retried. |

Setting either key adds a ninth tool, `negotiate_with_seller`, to what buyer agents can call.

## 2.8 Deployment, auth and timeouts

| Variable | Default | What it controls |
|---|---|---|
| `PARLEY_PUBLIC_URL` | auto-detected | Public URL of the deployment. Overrides everything; set it for a custom domain. |
| `PARLEY_API_KEY` | unset | Set to require `Authorization: Bearer <token>` on `/api/mcp`. Unset leaves the endpoint open to any agent that finds it. |
| `MERCHANT_API_KEY` | unset | Sent on every call to **your** APIs, if they need auth. |
| `MERCHANT_API_KEY_HEADER` | `Authorization` | Which header carries it. `Bearer ` is prefixed automatically for `Authorization`. |
| `MERCHANT_API_TIMEOUT_MS` | `15000` | How long to wait on your APIs before giving up. |
| `MERCHANT_ORDER_STATUS_API` | falls back to `MERCHANT_ORDER_API` | `GET` one order's status, if it lives elsewhere. Supports `{id}`. |

When `PARLEY_PUBLIC_URL` is unset the URL is taken from the incoming request, falling back to Vercel's own environment variables.

## 2.9 The tools an AI agent gets

| Tool | What it does |
|---|---|
| `search_products` | Searches your catalog and normalizes the result. Filters are applied by your API and again locally. |
| `get_product_details` | The full live record for one product. |
| `check_stock` | Live availability. Never cached. |
| `check_mandate` | A customer's standing spend cap and what remains of it. |
| `create_mandate` | Records a cap the customer explicitly authorized. |
| `create_order_and_pay` | Prices from your live catalog, clamps the discount, calls your order API, then charges an existing mandate or returns a payment link. |
| `check_order_status` | Reads order status from your system, which stays the source of truth. |
| `get_audit_trail` | What happened and why — readable by the buyer agent too. |
| `negotiate_with_seller` | Plain-language negotiation. Present only when a model provider key is set. |

---

# 3. Known limitations

**Read this before assuming full compatibility.**

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

# 4. Quickstart — from clone to a shareable link

### a. Clone and install

Requires **Node 20 or newer**.

```bash
git clone https://github.com/Mudavath-Giri-Naik/Parley.git
cd Parley
npm install
```

### b. Configure

```bash
cp .env.example .env.local
```

Fill in at minimum the four required variables from [2.1](#21-required). Then work through [section 2](#2-what-parley-adapts-to-automatically) for anything your API does differently — most importantly `PRICE_UNIT` ([2.3](#23-money)) and, if your field names are unusual, `FIELD_MAP` ([2.2](#22-the-shape-of-your-catalog)).

`.env.local` is gitignored. Never commit real keys.

### c. Set up a database

**Any Postgres works.** There is no provider lock-in: Parley connects with a standard connection string and creates both of its tables (`audit_log`, `mandates`) itself on first use. There is no migration to run.

A free [Supabase](https://supabase.com) or [Neon](https://neon.tech) project takes about a minute; a local `postgres` container is equally fine.

```bash
PARLEY_DB_URL=postgresql://user:password@host:5432/database?sslmode=require
```

TLS is decided automatically — off for `localhost`/`127.0.0.1`, on otherwise — and an explicit `sslmode=disable` or `sslmode=require` in the string is respected. Certificate verification is off by default, because managed Postgres behind a pooler often cannot be chained from a serverless runtime; set `PARLEY_DB_SSL_STRICT=true` to demand it.

You can skip this step to try things out — see [2.6](#26-storage-and-payments) for what stops working.

### d. Run locally and check the catalog

```bash
npm run dev
```

Open **<http://localhost:3000>** and confirm all of the following before you deploy:

1. **No "Configuration incomplete" box.** If it appears, it lists exactly which variables are missing or malformed.
2. **The capability cards** show what is enabled: catalog, payments, mandates, negotiation.
3. **Open `/.well-known/agent-commerce.json`** and check `merchant.name` and the tool list are right.
4. **Check a real product against your own database.** Call the MCP endpoint directly:

```bash
curl -s -X POST http://localhost:3000/api/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search_products","arguments":{"query":"shirt","limit":3}}}'
```

Confirm that `price_minor` is 100× your displayed price (`₹899.00` → `89900`), that `name` is populated rather than `"Unnamed product"`, and that `in_stock` reflects reality. **If products come back unnamed or unpriced, fix `FIELD_MAP` now** — it will not fix itself in production.

Then run the suite against it:

```bash
npm run test:regression
```

### e. Deploy to Vercel

Click the Deploy button at the top of this file, or from a clone:

```bash
npx vercel --prod
```

The project is a stock Next.js App Router app — there is no `vercel.json` and no special build configuration.

> **Your `.env.local` is not uploaded.** It is gitignored, and Vercel never reads it. Every variable must be re-entered under **Project → Settings → Environment Variables**, and the project **redeployed** afterwards — environment changes do not take effect on an existing deployment.

### f. Find your public MCP link

Open your deployed URL. The status page shows the full absolute address of both endpoints, each with a **Copy** button beside it:

```
MCP endpoint   https://your-project.vercel.app/api/mcp          [Copy]
Discovery      https://your-project.vercel.app/.well-known/…    [Copy]
```

The URL is derived from the live request, so it is always the address you actually reached. On a custom domain, set `PARLEY_PUBLIC_URL` so the discovery document advertises it too.

### g. Connect it to Claude

In Claude, open **Settings → Connectors → Add custom connector**, paste the MCP URL from the previous step, and add it. If you set `PARLEY_API_KEY`, supply that token when prompted; otherwise no authentication is needed.

The connector then appears in Claude's connector list and its tools become available in conversation — you may need to enable it for a given chat. Availability of custom connectors varies by plan, and the flow changes from time to time; see [Anthropic's documentation on custom connectors](https://support.anthropic.com/en/articles/11175166-about-custom-connectors-remote-mcp) for the current steps.

### h. Connect it to ChatGPT

OpenAI also supports connecting to remote MCP servers, so the same endpoint should work there. **This has not been tested against Parley**, and OpenAI's interface changes independently of this project, so rather than give you click-by-click steps that may already be wrong, follow their current official guide:

- [OpenAI — MCP documentation](https://platform.openai.com/docs/mcp)

The value you need is the same MCP URL from step (f).

### i. Sanity test

Once connected, paste this into the conversation:

```
Using the connected store, show me what's in stock right now,
with prices. Then check live availability for one of them.
```

You should get **real products from your own catalog** with correct prices, and the agent should call `check_stock` before confirming availability. Then open `/dashboard`: every one of those calls should be there, in order, with plain-language reasoning.

If products come back but prices look 100× off, revisit `PRICE_UNIT` ([2.3](#23-money)). If nothing comes back at all, revisit `FIELD_MAP` and envelope handling ([2.2](#22-the-shape-of-your-catalog) and [section 3](#3-known-limitations)).

---

## Testing

```bash
npm run test:regression    # drive a live deployment through its MCP endpoint
npm run check:template     # prove no merchant-specific values leaked into the source
npm run typecheck          # tsc --noEmit
```

The regression suite discovers its own fixtures from your configured catalog and checks Parley's answers against your raw API, so it works for any merchant. Point it anywhere:

```bash
PARLEY_MCP_URL=https://your-project.vercel.app/api/mcp npm run test:regression
```

Pin fixtures with `REGRESSION_PRODUCT_ID` and `REGRESSION_SOLDOUT_ID` — you will need the latter if your catalog hides sold-out products from its default listing. Six further checks cover refusal and outage handling; they need a second instance pointed at a stub, named by `PARLEY_STUB_MCP_URL` and `PARLEY_OUTAGE_MCP_URL`, and are skipped rather than failed when absent.

## Project layout

```
app/
  api/mcp/route.ts                          MCP endpoint (Streamable HTTP, JSON-RPC 2.0)
  api/agent/chat/route.ts                   direct line to the seller agent
  dashboard/page.tsx                        the audit trail, rendered for humans
  page.tsx                                  status page with the copyable MCP address
  .well-known/agent-commerce.json/route.ts  discovery, generated from config
lib/
  config.ts                                 every env var, read and validated once
  agentProviders.ts                         Anthropic / Gemini behind one interface
  merchantApi.ts                            the seam: envelopes, field mapping, refusals
  db.ts / auditLog.ts                       Parley's own Postgres and the shared logger
  razorpay.ts                               payment links on the merchant's own account
  sellerAgent.ts                            reasoning layer: persona from config
  mcp/server.ts                             protocol handling
  tools/                                    one file per tool, one shared definition shape
scripts/
  regression.mjs                            end-to-end suite against a live deployment
  check-template-purity.mjs                 proof this is still a template
```

The tool registry in `lib/tools/index.ts` has two consumers — the MCP endpoint and the seller agent — from one definition, so a buyer agent and your own agent are always bound by exactly the same limits.

## Contributing

Issues and pull requests are welcome. One rule above all others: if `npm run check:template` fails on your branch, that is the bug to fix first.

## License

MIT. See [LICENSE](LICENSE).
