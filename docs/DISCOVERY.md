# The Discovery Service

Parley is the transaction. This is the part that gets you found.

It sits beside Parley in this repository, reads the same catalog Parley reads, and
publishes it in the three forms an AI shopping agent looks for. It never places an
order — when an agent is ready to buy, everything here routes it into Parley's
existing MCP flow.

```
                          ┌─ /.well-known/ucp ──────── UCP profile (2026-08-25)
merchant's catalog API ───┼─ /api/discovery/feed ───── ACP product feed (2026-04-17)
   (the one Parley uses)  ├─ /p/{id} ───────────────── server-rendered page + schema.org
                          └─ /api/mcp ──────────────── Parley. Negotiation and purchase.
```

## What it publishes

| Endpoint | What it is |
| --- | --- |
| `GET /.well-known/ucp` | UCP business profile. Declares catalog search, catalog lookup, cart, the MCP transport, and the Razorpay payment handler. |
| `POST /api/discovery/ucp/catalog/search` | UCP `dev.ucp.shopping.catalog.search`. |
| `POST /api/discovery/ucp/catalog/lookup` | UCP batch lookup by id. |
| `POST /api/discovery/ucp/catalog/product` | UCP single-product detail. |
| `POST /api/discovery/ucp/carts` | UCP cart. `GET`/`PUT`/`cancel` on `/carts/{id}`. |
| `GET /api/discovery/feed` | ACP `ProductsResponse`, built live. |
| `GET /api/discovery/feed/meta` | ACP `FeedMetadata`. |
| `GET /p/{id}` | Server-rendered product page carrying `Product` JSON-LD. |
| `GET /api/discovery/jsonld/{id}` | The same JSON-LD as a paste-ready `<script>` block. |
| `GET|POST /api/discovery/crawlers` | Crawler access check. |
| `GET|POST /api/discovery/appearance` | Appearance probe log. |
| `GET /discovery` | The one page written for a human. |
| `GET /robots.txt`, `GET /sitemap.xml` | This service's own crawler surface. |

## The one manual step

**Point your own domain's `/.well-known/ucp` and `robots.txt` at this service.**

Nothing here can do that for you. A UCP platform looks for the profile at the apex of
the domain a shopper names — `https://yourshop.example.com/.well-known/ucp` — and this service
is deployed somewhere else. Until your domain answers there, an agent that starts from
your brand name finds nothing, however correct this deployment is.

Two lines of configuration on the storefront, whatever it runs on. For Vercel:

```json
{
  "redirects": [
    { "source": "/.well-known/ucp", "destination": "https://<this-deployment>/.well-known/ucp", "permanent": false }
  ]
}
```

Nginx:

```nginx
location = /.well-known/ucp { proxy_pass https://<this-deployment>/.well-known/ucp; }
```

Prefer a proxy to a redirect where you can — some platform fetchers do not follow
cross-origin redirects on well-known paths.

For `robots.txt`, the requirement is only that these four crawlers are not blocked.
Copy what this service serves at `/robots.txt`, or add to the file you already have:

```
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /
```

Then confirm it: `GET /api/discovery/crawlers` reads your live domain and reports
pass or fail for each crawler in plain language.

If your storefront renders product pages client-side, that check will also tell you.
Either server-render them, or inject the markup from `/api/discovery/jsonld/{id}` —
and in the meantime `/p/{id}` here is a readable, marked-up page per product that
crawlers can reach today.

## Configuration

Everything is optional. With none of it set, the service reads the catalog Parley is
already configured against and serves all of the above.

| Variable | Default | What it does |
| --- | --- | --- |
| `DISCOVERY_CACHE_TTL_MS` | `60000` | How long a catalog read is reused. Capped at 5 minutes. `0` disables caching. |
| `DISCOVERY_CATALOG_LIMIT` | `500` | Most products walked per read. |
| `DISCOVERY_CATALOG_PARAMS` | `{"include_sold_out":"true",…}` | Query parameters added to the catalog listing call. See below. |
| `DISCOVERY_GROUP_VARIANTS` | `true` | Collapse rows sharing a title into one product with variants. |
| `STOREFRONT_URL` | derived from `MERCHANT_SEARCH_API` | Origin the crawler checker inspects. |
| `DISCOVERY_PRODUCT_URL_TEMPLATE` | — | Your own product page, e.g. `https://shop.example.com/p/{id}`. |
| `DISCOVERY_FEED_TARGET_COUNTRY` | — | ISO-3166 alpha-2 code for the ACP feed. |
| `DISCOVERY_CRAWLERS` | `GPTBot,ClaudeBot,PerplexityBot,Google-Extended` | Which crawlers to check and allow. |
| `DISCOVERY_CART_SECRET` | falls back to `PARLEY_API_KEY` | Signs cart ids. |
| `APPEARANCE_QUESTIONS` | generated from the catalog | `|`-separated probe questions. |
| `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | — | Enable the corresponding appearance probe. |

### Sold-out products

`DISCOVERY_CATALOG_PARAMS` exists for one reason. Many storefronts hide sold-out
products from their default listing. To a shopping agent, a product that is absent
from the feed is a product the merchant does not sell — a worse and more permanent
claim than "out of stock". So the listing call asks for them explicitly, sending
several common spellings at once (`include_sold_out`, `include_out_of_stock`,
`include_unavailable`), on the same principle as Parley's search sending `q`, `query`
and `search` together: the one your API understands wins, the rest are ignored.

If your storefront spells it differently, set the variable:

```
DISCOVERY_CATALOG_PARAMS={"show_all":"1"}
```

## No second copy of the data

Every endpoint reads through `lib/discovery/catalog.ts`, which calls the same
`MERCHANT_SEARCH_API` and `MERCHANT_STOCK_API` that Parley's MCP tools call, through
the same normalizer in `lib/merchantApi.ts`. There is no import job, no synced table,
and no build-time snapshot. A price change appears everywhere within
`DISCOVERY_CACHE_TTL_MS`, with no redeploy.

`npm run test:discovery` proves this rather than asserting it — see below.

Two deliberate differences from Parley's read path: nothing here writes to the audit
log, because crawler traffic would bury the record of what a real customer's agent
did; and reads are cached, which Parley's `check_stock` never is. The cache is never
consulted when a purchase is committed. That path is still Parley's.

## What is declared, and what is not

The profile advertises only what this deployment actually serves.

**Catalog search, catalog lookup and cart** are implemented here, against the live
catalog, and declared under their `dev.ucp.*` names.

**Checkout is not.** Parley already owns the purchase, over MCP, with a discount
ceiling and spend mandates enforced in code. Re-implementing it as a UCP REST checkout
would mean a second checkout with a second set of limits to keep in step — exactly what
the brief said not to build. So the profile declares a checkout *handoff* under this
deployment's own reverse-domain namespace, whose config names the MCP tool for each
step of a purchase. A UCP platform is routed into the flow that works instead of being
told to call endpoints that do not exist.

That naming is not cosmetic. UCP binds a name's authority to the domain it reverses
and requires an entity's `schema` URL to originate from that domain, so a capability
named `dev.ucp.shopping.checkout` must behave like UCP's checkout. Ours does not, so
it is not called that.

A deployment reached by IP address has no domain to claim authority under — reversing
`127.0.0.1` gives `1.0.0.127`, which is not a legal reverse-domain name — so it
declares no vendor capability at all. The same routing is published on the
`dev.ucp.shopping` MCP service binding, which needs no authority claim, so nothing is
lost but the extra declaration.

## Testing

```bash
npm run dev
npm run test:discovery
```

The suite validates against the published specifications, downloaded at run time
rather than reimplemented:

- the UCP profile, the catalog search response and the cart against `ucp.dev`'s own
  schemas, with ajv, following `$ref` across every referenced document;
- the ACP feed against `schema.feed.json` from the agentic-commerce-protocol
  repository;
- the JSON-LD on a product page against `validator.schema.org`.

It names no product, price or merchant: expectations come from the catalog at run
time, the same way Parley's regression suite works.

### Proving the data is live

The suite's default run cross-checks every feed price against the merchant's API as it
stands right now, which a build-time snapshot could not match. To prove the stronger
claim — that a change at the source arrives without a redeploy — run against a stub
catalog whose values the suite can change mid-run:

```bash
node scripts/stub-catalog.mjs                       # terminal 1

MERCHANT_NAME="Stub" \
MERCHANT_SEARCH_API=http://127.0.0.1:4319/products \
MERCHANT_STOCK_API=http://127.0.0.1:4319/products \
MERCHANT_ORDER_API=http://127.0.0.1:4319/orders \
PRICE_UNIT=minor DISCOVERY_CACHE_TTL_MS=2000 \
npx next dev -p 3100                                # terminal 2

DISCOVERY_URL=http://127.0.0.1:3100 \
DISCOVERY_STUB_URL=http://127.0.0.1:3100 \
DISCOVERY_STUB_SOURCE=http://127.0.0.1:4319 \
DISCOVERY_STUB_TTL_MS=2000 \
DISCOVERY_SOLDOUT_ID=stub-002 \
npm run test:discovery                              # terminal 3
```

The suite changes a price and a stock level at the source, waits out the TTL, and
checks that the ACP feed, the UCP catalog and the JSON-LD all report the new values.

## The appearance log

`npm run discovery:probe` asks buyer-style questions — "best {category} under
{price}", built from your own catalog — of whichever assistants expose a
programmatic, search-grounded interface, and records what came back.

Read the label before the numbers:

> Observed appearance, not a guaranteed ranking.

Each row is one answer, from one API, at one moment. Nothing here observes position,
because none of these interfaces reports one, and nothing here predicts tomorrow.

What can actually be tested differs by platform, and the log says so per row rather
than quietly averaging over it:

| Platform | Tested via | Notes |
| --- | --- | --- |
| Gemini | Gemini API with Google Search grounding | Real search-grounded answers. Grounding is a paid-tier feature; a free key returns 429 and the probe records that rather than falling back to an ungrounded answer. |
| Claude | Anthropic Messages API with the `web_search` tool | Real search-backed answers. |
| Perplexity | Sonar API | Real search-backed answers; the API is the product's own retrieval stack. |
| ChatGPT | OpenAI Responses API with `web_search` | **A proxy, not ChatGPT.** ChatGPT the product has no API and no shopping-surface API. The API's retrieval is not the same stack, and every row says so in its `via` field. |

A platform with no key configured is recorded as untestable with the reason. No result
is ever invented for one.

Storage: `supabase/0002_discovery.sql` creates a dedicated append-only
`discovery_appearance_log`, isolated by `merchant_id` under the same RLS pattern as
Parley's tables. It is optional — without it, probes are written to Parley's existing
`audit_log` under a system actor, and the report says which store it read. A proof log
that silently discards its evidence because a migration was skipped is worse than a
slightly noisier audit trail.

## What this does not do

It does not make you appear in an AI assistant's answers. It makes you legible to the
agents that look, and it tells you honestly when they cannot see you. Whether any
assistant then recommends you is theirs to decide, and no part of this repository
claims otherwise.
