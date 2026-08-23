<div align="center">

<img src="assets/banner.svg" alt="Parley" width="100%">

<br>

**Turn your store's existing APIs into an AI seller agent.**

Any AI agent — Claude, ChatGPT, Gemini — can browse your catalog, negotiate, and buy. Within your limits. Fully audited. On your own infrastructure.

<br>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMudavath-Giri-Naik%2FParley&env=MERCHANT_NAME,MERCHANT_SEARCH_API,MERCHANT_STOCK_API,MERCHANT_ORDER_API,RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET,PARLEY_DB_URL&envDescription=Point%20Parley%20at%20your%20own%20storefront%20APIs%20and%20payment%20keys&envLink=https%3A%2F%2Fgithub.com%2FMudavath-Giri-Naik%2FParley%2Fblob%2Fmain%2Fdocs%2FCONFIGURATION.md)

`Next.js` · `MCP` · `Postgres` · `Razorpay` · `MIT`

[Configuration](docs/CONFIGURATION.md) · [Limitations](docs/LIMITATIONS.md)

</div>

---

## Architecture

```mermaid
flowchart LR
    subgraph EXT [ Their AI client ]
        direction TB
        BA[Buyer agent<br/><i>Claude · ChatGPT · Gemini</i>]
    end

    subgraph PARLEY [ Your Parley deployment ]
        direction TB
        WK[".well-known/<br/>agent-commerce.json"]
        MCP["MCP endpoint<br/><b>/api/mcp</b>"]
        TOOLS["9 tools<br/><i>search · stock · order<br/>mandate · audit</i>"]
        SELLER["Seller agent<br/><i>persona + limits</i>"]
        DASH["Dashboard<br/><b>/dashboard</b>"]
        PG[("Postgres<br/>audit_log · mandates")]
    end

    subgraph STORE [ Your existing store ]
        direction TB
        API1["GET  search"]
        API2["GET  product"]
        API3["POST order"]
    end

    RZP[["Razorpay<br/>payment link"]]
    U([Customer])

    U --> BA
    BA <-->|"discovers"| WK
    BA <-->|"JSON-RPC"| MCP
    MCP --> TOOLS
    TOOLS <--> SELLER
    TOOLS -->|"read"| API1
    TOOLS -->|"read"| API2
    TOOLS -->|"write"| API3
    TOOLS -->|"log every decision"| PG
    TOOLS -->|"needs approval"| RZP
    PG --> DASH

    classDef ext fill:#1e293b,stroke:#475569,color:#e2e8f0
    classDef core fill:#0f2942,stroke:#2563eb,color:#dbeafe
    classDef store fill:#0f2e1f,stroke:#16a34a,color:#dcfce7
    classDef pay fill:#2e1f0f,stroke:#d97706,color:#fed7aa
    class BA ext
    class WK,MCP,TOOLS,SELLER,DASH,PG core
    class API1,API2,API3 store
    class RZP pay
```

**Parley never writes to your database.** Every order goes through your own API.

## How a purchase happens

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer
    participant B as Buyer agent
    participant P as Parley
    participant S as Your store
    participant R as Razorpay

    C->>B: "Buy a navy tee under ₹1500"
    B->>P: search_products
    P->>S: GET search
    S-->>P: catalog
    P-->>B: normalized products

    B->>P: check_stock
    P->>S: GET product (live, never cached)
    S-->>P: stock: 8

    B->>P: create_order_and_pay
    Note over P: discount clamped in code

    P->>S: POST order
    alt Out of stock
        S-->>P: 409 out_of_stock
        P-->>B: blocked · nothing charged
    else Store is down
        S-->>P: 5xx
        P-->>B: unavailable · try again
    else Accepted
        S-->>P: order_id

        alt Mandate covers the amount
            P->>P: charge against cap
            P-->>B: completed · no human needed
        else No mandate
            P->>R: create payment link
            R-->>P: link
            P-->>B: awaiting approval
            B-->>C: pay here →
        end
    end

    P->>P: write audit_log row
```

---

## Quickstart

### 1 · Clone

```bash
git clone https://github.com/Mudavath-Giri-Naik/Parley.git
cd Parley
npm install
```

> Requires Node 20+

### 2 · Configure

```bash
cp .env.example .env.local
```

Set these four:

```bash
MERCHANT_NAME="Your Store"
MERCHANT_SEARCH_API=https://yourstore.com/api/products
MERCHANT_STOCK_API=https://yourstore.com/api/products
MERCHANT_ORDER_API=https://yourstore.com/api/orders
```

Then set `PRICE_UNIT` to match your API:

| Your API returns `1499` for a ₹1,499 item | `PRICE_UNIT=major` |
|---|---|
| **Your API returns `149900` for a ₹1,499 item** | **`PRICE_UNIT=minor`** |

→ Everything else: **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**

### 3 · Add a database

Any Postgres. Free [Supabase](https://supabase.com) or [Neon](https://neon.tech) works. Tables are created automatically.

```bash
PARLEY_DB_URL=postgresql://user:pass@host:5432/db?sslmode=require
```

### 4 · Add payment keys

From your [Razorpay dashboard](https://dashboard.razorpay.com) → Settings → API Keys.

```bash
RAZORPAY_KEY_ID=rzp_test_xxxxx
RAZORPAY_KEY_SECRET=xxxxx
```

### 5 · Run locally

```bash
npm run dev
```

Open <http://localhost:3000> and confirm:

- [ ] No "Configuration incomplete" warning
- [ ] Capability cards show green
- [ ] Prices match your real catalog

```bash
npm run test:regression
```

### 6 · Deploy

```bash
npx vercel --prod
```

> ⚠️ **Re-enter every variable** in Vercel → Settings → Environment Variables, then redeploy. `.env.local` is not uploaded.

### 7 · Copy your MCP link

Open your deployed URL. Click **Copy** next to the MCP endpoint.

```
https://your-project.vercel.app/api/mcp
```

### 8 · Connect to Claude

**Settings → Connectors → Add custom connector** → paste the URL → **Add**.

<sub>[Claude connector docs](https://support.anthropic.com/en/articles/11175166-about-custom-connectors-remote-mcp) · For ChatGPT, see [OpenAI's MCP docs](https://platform.openai.com/docs/mcp) — untested here</sub>

### 9 · Test it

Paste into the chat:

```
Show me what's in stock right now, with prices.
Then check live availability for one of them.
```

Then open `/dashboard` — every call appears with its reasoning.

---

## What's built in

| | |
|---|---|
| 🔒 **Discount ceiling** | Enforced in code, not by the prompt |
| 💳 **Spend mandates** | Unattended purchases only within a customer-authorized cap |
| 📦 **Live stock** | Never cached, checked before every promise |
| 📝 **Full audit trail** | Every decision logged with plain-language reasoning |
| 🔌 **Any API shape** | Field names mapped via config, not code |
| 🤝 **Negotiation** | Optional, via Claude or Gemini |

## Commands

```bash
npm run dev                 # local dev server
npm run build               # production build
npm run test:regression     # end-to-end suite against a live deployment
npm run check:template      # verify no merchant values leaked into source
npm run typecheck           # tsc --noEmit
```

## Project layout

```
app/
  api/mcp/route.ts          MCP endpoint
  dashboard/                audit trail UI
  page.tsx                  status page + copyable MCP link
lib/
  config.ts                 all env vars, validated once
  merchantApi.ts            field mapping, envelopes, refusals
  tools/                    one file per tool
  sellerAgent.ts            negotiation
scripts/
  regression.mjs            end-to-end tests
```

## Docs

- **[Configuration](docs/CONFIGURATION.md)** — every env var, the order API contract
- **[Limitations](docs/LIMITATIONS.md)** — known gaps, read before deploying

## License

MIT
