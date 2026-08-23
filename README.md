<div align="center">

# Parley

**Your storefront, negotiating for itself.**

A self-hostable template that turns any merchant's existing e-commerce APIs into an AI seller agent — one that any external buyer agent (Claude, ChatGPT, Gemini) can discover, negotiate with, and buy from, within limits you set and with every decision on the record.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMudavath-Giri-Naik%2FParley&env=MERCHANT_NAME,MERCHANT_SEARCH_API,MERCHANT_STOCK_API,MERCHANT_ORDER_API,RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET,PARLEY_DB_URL,MAX_DISCOUNT_PERCENT,AGENT_PERSONA,SPEND_CAP_DEFAULT&envDescription=Point%20Parley%20at%20your%20own%20storefront%20APIs%20and%20payment%20keys&envLink=https%3A%2F%2Fgithub.com%2FMudavath-Giri-Naik%2FParley%23environment-variables)

`Next.js` · `MCP over Streamable HTTP` · `Postgres` · `Razorpay` · `Claude or Gemini` · `MIT`

</div>

---

## The problem

Your customers have started shopping with AI agents. Those agents can read your website, badly. They cannot check whether the last one in your size is actually still there, they cannot ask you for a better price, and they certainly cannot pay you.

The usual answer is to wait for a marketplace to add you to their catalog, on their terms, with their cut.

Parley is the other answer: **you run your own seller agent.** It sits in front of the APIs you already have, speaks the Model Context Protocol so any AI agent can connect to it, and does business inside limits you define. You deploy your own copy, with your own keys, on your own infrastructure. The Parley project never sees your credentials, your catalog, or your customers.

## What it does

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

The seller agent's system prompt asks it to behave well. That is not the safeguard. The safeguard is the code — which is why the caps live in `createOrderAndPay.ts` and in the database, not in the prompt.

## Quick start

**You need:** an e-commerce backend with a couple of JSON endpoints, a Postgres database you control (a free Supabase or Neon project is fine), and Razorpay keys if you want to take payment.

```bash
git clone https://github.com/Mudavath-Giri-Naik/Parley.git
cd Parley
npm install
cp .env.example .env.local     # then fill it in
npm run dev
```

Open <http://localhost:3000> for the status page, `/dashboard` for the audit trail, and `/.well-known/agent-commerce.json` to see what an AI agent discovers about you.

Or click **Deploy** above and fill the variables into Vercel directly.

## Environment variables

This is the entire customization system. There is no config file to edit and no code to fork.

### Required

| Variable | What it is |
|---|---|
| `MERCHANT_NAME` | Your business name. Used in the agent's prompt, the discovery document, and the dashboard. |
| `MERCHANT_SEARCH_API` | `GET`, returns a list of products. Parley sends `?q=` (plus `?query=`/`?search=`) and, when the customer asks for them, `?size=`, `?color=`, `?max_price=`. |
| `MERCHANT_STOCK_API` | `GET` one product. Used for both product details and live stock checks. |
| `MERCHANT_ORDER_API` | `POST`, creates an order and reserves stock. **Your** backend owns the stock lock; Parley only calls it. |
| `PARLEY_DB_URL` | Postgres for Parley's own `audit_log` and `mandates` tables. Separate from your product database. Tables are created automatically on first use. |

Without `PARLEY_DB_URL`, Parley still runs: decisions go to the server log, and spend mandates are unavailable (every purchase then needs human approval).

### Required for taking payment

| Variable | What it is |
|---|---|
| `RAZORPAY_KEY_ID` | Your Razorpay key. Test-mode keys start with `rzp_test_`. |
| `RAZORPAY_KEY_SECRET` | Your Razorpay secret. Payment links are created on **your** account; Parley never sees a card number. |

### Limits and behaviour

| Variable | Default | What it is |
|---|---|---|
| `MAX_DISCOUNT_PERCENT` | `10` | Hard ceiling on any discount, enforced in code. `0` disables discounting entirely. |
| `AGENT_PERSONA` | `Friendly, concise, never pushy` | How your agent should come across. |
| `SPEND_CAP_DEFAULT` | `500000` | Default cap for a new mandate, in **minor units** (500000 = ₹5,000.00). |
| `MANDATE_TTL_DAYS` | `30` | How long a new mandate stays valid. |
| `CURRENCY` | `INR` | ISO currency code for payment and display. |

### Speaking your API's language

| Variable | Default | What it is |
|---|---|---|
| `PRICE_UNIT` | `major` | Does your API report `1499` as ₹1,499 (`major`) or as ₹14.99 (`minor`)? **Getting this wrong misprices every order.** |
| `FIELD_MAP` | *(unset)* | Only needed when your field names differ and aren't already recognized: `{"name":"title","price":"cost","stock":"qty"}`. Keys are Parley's names, values are yours. Valid keys: `id`, `name`, `price`, `stock`, `currency`, `description`, `image`, `url`, `size`, `color`. |
| `OUT_OF_STOCK_PATTERN` | common phrasings | Regex identifying your API's out-of-stock refusal. Applied only to 2xx/4xx replies: a 5xx is always an outage, never "sold out". |
| `ORDER_SUCCESS_FIELDS` | `ok,success,succeeded,is_success,isSuccess` | Body fields that mean "accepted". Any of them set to `false` refuses the order, even on HTTP 200. |
| `ORDER_ERROR_FIELDS` | `error,errors,error_code,…` | Body fields that carry a refusal. Content in any of them refuses the order; empty values (`null`, `""`, `[]`) do not. |
| `MERCHANT_ORDER_STATUS_API` | `MERCHANT_ORDER_API` | `GET` one order's status, if it lives at a different URL. |
| `MERCHANT_API_KEY` / `MERCHANT_API_KEY_HEADER` | *(unset)* / `Authorization` | Sent on every call to your APIs, if they need auth. |
| `MERCHANT_API_TIMEOUT_MS` | `15000` | How long to wait on your APIs before giving up. |

### Optional extras

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | Either one enables the conversational seller agent and the `negotiate_with_seller` tool. Without a provider key the other tools all still work — a buyer agent can browse and transact, it just can't haggle with anyone. Set whichever you already pay for; you don't need both. |
| `AGENT_PROVIDER` | `auto` (default), `anthropic`, or `gemini`. `auto` uses whichever key is set, preferring Anthropic if both are. |
| `AGENT_MODEL` | Anthropic model. Defaults to `claude-opus-5`. |
| `GEMINI_MODEL` | Gemini model. Defaults to `gemini-3.7-flash`. |
| `GEMINI_MAX_ATTEMPTS` | How many times to retry a Gemini call that fails because the model is busy. Defaults to `4`. |
| `PARLEY_PUBLIC_URL` | Public URL of the deployment. Auto-detected on Vercel; set it if you use a custom domain. |
| `PARLEY_API_KEY` | Set to require `Authorization: Bearer <token>` on the MCP endpoint. Unset leaves it open to any agent that finds it. |
| `PAYMENT_CALLBACK_URL` | Where Razorpay returns the customer after payment. |
| `PARLEY_DB_SSL_STRICT` | `true` to verify the database's TLS chain. Leave unset for managed Postgres behind a pooler. |

## What your API has to look like

Parley adapts to you, within reason. Envelopes like `{"data": {...}}`, `{"products": [...]}`, `{"items": [...]}`, `{"results": [...]}` are unwrapped automatically, and common field aliases (`title`, `cost`, `qty`, `quantity`, `stock_count`, `image_url`, `in_stock`, …) are recognized without any `FIELD_MAP` at all.

**Search** — `GET {MERCHANT_SEARCH_API}?q=navy+tee`

```jsonc
{ "products": [
  { "id": "sku_123", "name": "Navy Tee", "price": 1499, "stock_count": 8,
    "size": "M", "color": "Navy", "image_url": "https://..." }
] }
```

**One product** — `GET {MERCHANT_STOCK_API}/sku_123`, or put `{id}` anywhere in the URL (`https://you.example.com/api/products/{id}/detail`) and Parley substitutes it.

**Create an order** — `POST {MERCHANT_ORDER_API}`

```jsonc
// Parley sends both snake_case and camelCase, so most backends need no adapter:
{ "product_id": "sku_123", "quantity": 1,
  "customer_name": "...", "customer_email": "...",
  "amount_minor": 149900, "currency": "INR", "discount_percent": 10, "source": "parley" }
```

Return `2xx` with an order id (`order_id`, `id`, `reference`, …) to accept. To refuse for lack of stock, return `409`, or any status with a body your `OUT_OF_STOCK_PATTERN` matches:

```jsonc
{ "ok": false, "error": "out_of_stock", "message": "This item is sold out." }
```

Parley treats that as a normal answer, not a crash: it logs `result: 'blocked'`, tells the buyer agent nothing was charged, and prompts it to offer the customer a real alternative.

## The tools an AI agent gets

| Tool | What it does |
|---|---|
| `search_products` | Searches your catalog, normalizes the result, applies size/colour/price filters twice — once as query params, once locally — in case your API ignores them. |
| `get_product_details` | The full live record for one product. |
| `check_stock` | Live availability. Never cached, ever. |
| `check_mandate` | Looks up a customer's standing spend cap and what's left of it. |
| `create_mandate` | Records a cap the customer explicitly authorized. |
| `create_order_and_pay` | Prices from your live catalog, clamps the discount, asks your API to reserve stock, then either charges an existing mandate or returns a payment link for a human to approve. |
| `check_order_status` | Reads order status from your system, which stays the source of truth. |
| `get_audit_trail` | The record of what happened and why — readable by the buyer agent too, so a customer's own agent can ask "what did you just do?" |
| `negotiate_with_seller` | Talk to your seller agent in plain language. Only present when a model provider key is set. |

## Choosing a model provider

The seller agent's reasoning runs on either **Anthropic** or **Google Gemini**. Providers live behind one interface in `lib/agentProviders.ts` and translate protocol only — tool execution, the audit trail, and every limit stay in `sellerAgent.ts`, so the safeguards cannot drift apart between backends.

```bash
AGENT_PROVIDER=gemini
GEMINI_API_KEY=...            # modern AQ... keys work natively
GEMINI_MODEL=gemini-3.7-flash
```

Gemini support uses `@google/genai`, the current unified SDK. The legacy `google-generative-ai` packages mishandle newer `AQ...` keys by treating them as OAuth tokens, which is why Parley does not use them. Tool schemas are passed through `parametersJsonSchema`, so Parley's tool definitions are handed over as-is with no lossy translation, and model turns are echoed back verbatim to preserve Gemini 3.x thought signatures across tool calls.

**Watch the free-tier quota.** `gemini-3.7-flash` allows only 20 requests per day on the free tier, and a single negotiation can spend several. `gemini-3.5-flash-lite` is more forgiving while you're testing. Busy-model errors (`503`, per-minute `429`) are retried with exponential backoff; a daily quota is not, since it won't recover in the time anyone is willing to wait.

## Connecting an AI agent

Your MCP endpoint is `https://<your-deployment>/api/mcp`, over **Streamable HTTP** — the transport remote and custom connectors actually support (not stdio).

**Claude** — Settings → Connectors → Add custom connector → paste the URL. If you set `PARLEY_API_KEY`, give the token when asked. The tools appear in the conversation.

**Anything else** — point it at the same URL, or at `/.well-known/agent-commerce.json`, which describes the merchant, the endpoint, the auth scheme, and every available tool. It is generated from config at request time, so it can never drift from the deployment.

## The dashboard

`/dashboard` renders the audit log as a narrative: timestamp, actor, action, plain-language reasoning, and outcome (`success` / `blocked` / `failed` / `awaiting payment`). Filter with `?customer=someone@example.com`, or widen with `?limit=250`.

It is written for the merchant, not for a developer. If you can read this page and understand every decision your agent made on your behalf, the system is doing its job.

## Deploying a fresh instance, from nothing

1. **Have the three endpoints.** Search, one-product, and create-order, as above. If your storefront has no order endpoint yet, add one — Parley deliberately does not reimplement your stock locking or your order pipeline.
2. **Create a Postgres database.** A free Supabase or Neon project takes a minute. Copy the connection string. Parley creates its two tables itself; no migration to run.
3. **Get Razorpay test keys.** Razorpay Dashboard → Settings → API Keys, in Test Mode. Keys start with `rzp_test_`.
4. **Deploy.** Click the Deploy button, or `vercel --prod` from a clone. Fill in the environment variables, minding `PRICE_UNIT`.
5. **Check `/.well-known/agent-commerce.json`.** It should list your merchant name, your endpoint, and the tools. Any `configuration_incomplete` key tells you exactly what is still missing.
6. **Connect it to Claude** as a custom connector, and ask it to browse your catalog.
7. **Buy something.** Once without a mandate — you should get a payment link and no charge until you pay it. Then authorize a mandate and buy again — it should complete with no approval step, with the cap decremented.
8. **Try something that's out of stock.** You should get an honest refusal, a suggested alternative, and a `blocked` row in the dashboard.
9. **Read `/dashboard`.** Every step above should be there, in order, in plain language.

## Verifying it's still a template

Parley has exactly one hard architectural rule: **no merchant-specific value appears anywhere in the source.** There's a check for that:

```bash
npm run check:template                       # no hardcoded URLs outside shared infrastructure
node scripts/check-template-purity.mjs acme  # ...and no occurrence of a given business name
```

It scans every source file (README and `.env.example` excluded, since that's where examples belong) and fails on any absolute URL that isn't shared infrastructure, plus any business name you pass it. If it passes, the codebase you're holding is genuinely a template and not someone's deployment with the serial numbers filed off.

## Project layout

```
app/
  api/mcp/route.ts                        MCP endpoint (Streamable HTTP, JSON-RPC 2.0)
  api/agent/chat/route.ts                 direct line to the seller agent
  dashboard/page.tsx                      the audit trail, rendered for humans
  .well-known/agent-commerce.json/route.ts  discovery, generated from config
lib/
  config.ts                               every env var, read and validated once
  agentProviders.ts                       Anthropic / Gemini behind one interface
  merchantApi.ts                          the seam: envelopes, field mapping, normalization
  db.ts / auditLog.ts                     Parley's own Postgres and the shared logger
  razorpay.ts                             payment links on the merchant's own account
  sellerAgent.ts                          reasoning layer: persona from config, tools from the registry
  mcp/server.ts                           protocol handling
  tools/                                  one file per tool, all sharing one definition shape
scripts/check-template-purity.mjs         proof this is still a template
```

The tool registry in `lib/tools/index.ts` has two consumers — the MCP endpoint and the seller agent — from one definition, so a buyer agent and the seller agent are always bound by exactly the same limits.

## Known limitations

- **Payments are Razorpay-only.** `lib/razorpay.ts` is a single, self-contained module behind a small interface; another provider is a file, not a refactor.
- **Payment confirmation is not wired to a webhook.** A purchase without a mandate returns a payment link and is logged as `pending`. Parley does not currently listen for Razorpay's "paid" callback, so that row stays `pending` even after the customer pays. Reconcile via `check_order_status` for now.
- **Mandates cannot be revoked through a tool.** They expire, and they exhaust, but withdrawing one early means a row update in your own database.
- **The seller agent is stateless between MCP calls.** `negotiate_with_seller` starts a fresh conversation each time. The buyer agent is the one holding the thread, which is usually what you want, but it means the seller does not remember the last message on its own.
- **One mandate per customer at a time**, enforced by a partial unique index.

## Contributing

Issues and pull requests are welcome. One rule above all others: if `npm run check:template` fails on your branch, that's the bug to fix first.

## License

MIT. See [LICENSE](LICENSE).
