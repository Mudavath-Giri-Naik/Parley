<div align="center">

<img src="assets/banner.svg" alt="Parley — your storefront, negotiating for itself" width="100%">

<h3>Turn your store's existing APIs into an AI seller agent.</h3>

<p>
  <b>Browse &nbsp;·&nbsp; Negotiate &nbsp;·&nbsp; Buy</b><br>
  Any AI agent can transact with your storefront — within limits <b>you enforce in code</b>,<br>
  with <b>every decision audited</b>. No replatforming. No SDK for your customers.
</p>

<br>

<sub><b>W O R K S &nbsp; W I T H</b></sub>

<p>
  <img alt="Claude" src="https://img.shields.io/badge/Claude-D97757?style=for-the-badge&logo=anthropic&logoColor=white">
  <img alt="ChatGPT" src="https://img.shields.io/badge/ChatGPT-412991?style=for-the-badge">
  <img alt="Gemini" src="https://img.shields.io/badge/Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white">
  <img alt="Any MCP client" src="https://img.shields.io/badge/any_MCP_client-6EA8FE?style=for-the-badge&logo=modelcontextprotocol&logoColor=0B0F16">
</p>

<sub><b>B U I L T &nbsp; W I T H</b></sub>

<p>
  <img alt="Next.js 15" src="https://img.shields.io/badge/Next.js_15-0B0F16?style=for-the-badge&logo=nextdotjs&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/Postgres-4169E1?style=for-the-badge&logo=postgresql&logoColor=white">
  <img alt="Razorpay" src="https://img.shields.io/badge/Razorpay-0C2451?style=for-the-badge&logo=razorpay&logoColor=white">
  <img alt="Vercel" src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white">
</p>

<p>
  <code>agentic commerce</code> ·
  <code>MCP server</code> ·
  <code>seller agent</code> ·
  <code>spend mandates</code> ·
  <code>discount ceiling</code> ·
  <code>live stock</code> ·
  <code>audit trail</code> ·
  <code>self-hosted</code>
</p>

<br>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMudavath-Giri-Naik%2FParley&env=MERCHANT_NAME,MERCHANT_SEARCH_API,MERCHANT_STOCK_API,MERCHANT_ORDER_API,RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET,PARLEY_DB_URL&envDescription=Point%20Parley%20at%20your%20own%20storefront%20APIs%20and%20payment%20keys&envLink=https%3A%2F%2Fgithub.com%2FMudavath-Giri-Naik%2FParley%2Fblob%2Fmain%2Fdocs%2FCONFIGURATION.md)

<p>
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-4ADE80?style=flat-square">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A5_20-4ADE80?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-yes-6EA8FE?style=flat-square">
  <img alt="Bring your own DB" src="https://img.shields.io/badge/bring_your_own-Postgres-6EA8FE?style=flat-square">
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-6EA8FE?style=flat-square">
</p>

<a href="#before-you-start">Before you start</a> ·
<b><a href="#quickstart">Quickstart</a></b> ·
<a href="#architecture">Architecture</a> ·
<a href="#how-a-purchase-happens">How a purchase happens</a> ·
<a href="#whats-built-in">Features</a> ·
<a href="docs/CONFIGURATION.md">Configuration</a> ·
<a href="docs/LIMITATIONS.md">Limitations</a>

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

## Before you start

**Parley does not run your store. It talks to the store you already have.**

Almost every business online today already has a website, and behind that website
are real APIs — the same endpoints your own site calls to list products, check
stock and place orders. Parley plugs into those. This is the one hard requirement.

**You need three HTTP endpoints:**

| Endpoint | What it must do | Example |
|---|---|---|
| **Search products** | Return your catalog, so the agent can find items | `GET /api/products` |
| **Get one product** | Return a single product with its live stock | `GET /api/products/:id` |
| **Create an order** | Reserve the stock and return an order id | `POST /api/orders` |

One more is optional: an order-status endpoint. Leave it unset and Parley reuses
your order API.

Field names and JSON shape are up to you — you map them in config, not in code,
so no existing endpoint has to be rewritten to fit Parley.

> **If you do not have these APIs yet, Parley has nothing to connect to.**
> It never scrapes your website and never reads your database directly. Expose
> the three endpoints first, then come back to the steps below.

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

Any Postgres. Free [Supabase](https://supabase.com) or [Neon](https://neon.tech) works.

Run [`supabase/0001_shared_schema.sql`](supabase/0001_shared_schema.sql) against it — it creates the tables, a `parley_app` role, and the row-level isolation policies. Every row of its verification query must read PASS.

```bash
PARLEY_DB_URL=postgresql://parley_app:pass@host:5432/db?sslmode=require
```

> Connect as `parley_app`, not as a superuser. A superuser bypasses row-level security, which silently removes the isolation layer.
>
> On Supabase, use the **pooler** connection string (Project Settings → Database → Connection pooling). The direct `db.<ref>.supabase.co` host is IPv6-only and will not resolve on most IPv4 networks.

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
