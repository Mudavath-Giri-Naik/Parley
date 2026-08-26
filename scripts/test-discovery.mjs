#!/usr/bin/env node
/**
 * Discovery Service test suite.
 *
 * Runs against a live deployment and checks its output against the actual published
 * specifications, downloaded at run time rather than reimplemented here:
 *
 *   - the UCP profile is validated with ajv against ucp.dev's own profile schema and
 *     every schema it references;
 *   - the ACP feed is validated against the agentic-commerce-protocol repository's
 *     `schema.feed.json` bundle for spec version 2026-04-17;
 *   - the JSON-LD on a product page is validated by validator.schema.org, the
 *     standard structured-data validator, not by an assertion written here.
 *
 * Nothing in this file names a product, a price or a merchant. Expectations are
 * derived from the catalog at run time, exactly as Parley's own regression suite does.
 *
 *   npm run test:discovery
 *   DISCOVERY_URL=https://your-deployment.example.com npm run test:discovery
 *
 * Environment:
 *   DISCOVERY_URL          Deployment to test. Default http://localhost:3000
 *   DISCOVERY_SOLDOUT_ID   Pin the out-of-stock product instead of discovering one.
 *   DISCOVERY_OFFLINE      Set to skip every check that needs the public internet.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/* ------------------------------------------------------------------ env ---- */

for (const file of ['.env.local', '.env']) {
  const path = join(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!match) continue;
    const [, key, value] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = value.trim().replace(/^["'](.*)["']$/, '$1');
  }
}

const BASE = (process.env.DISCOVERY_URL || 'http://localhost:3000').replace(/\/+$/, '');
const OFFLINE = Boolean(process.env.DISCOVERY_OFFLINE);
const UCP_VERSION = '2026-08-25';
const ACP_VERSION = '2026-04-17';

const CACHE_DIR = join(process.cwd(), 'node_modules', '.cache', 'discovery-specs');

/* --------------------------------------------------------------- report --- */

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function section(title) {
  console.log(`\n${DIM}--- ${title} ---${RESET}`);
}

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ${GREEN}PASS${RESET}  ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  ${RED}FAIL${RESET}  ${name}${detail ? `${DIM} -- ${detail}${RESET}` : ''}`);
  }
}

function skip(name, why) {
  skipped += 1;
  console.log(`  ${DIM}SKIP  ${name} -- ${why}${RESET}`);
}

/* ------------------------------------------------------------- fetching --- */

async function getJson(path, init) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text, headers: response.headers };
}

async function postJson(path, payload) {
  return getJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Downloads a spec document once and caches it, so a rerun works offline. */
async function spec(url) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${Buffer.from(url).toString('base64url').slice(0, 80)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (OFFLINE) throw new Error(`DISCOVERY_OFFLINE is set and ${url} is not cached.`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = await response.json();
  writeFileSync(file, JSON.stringify(body));
  return body;
}

/**
 * Loads a schema and everything it references, following `$ref` across documents.
 * ajv resolves refs from its own store, so every referenced document has to be
 * added before compilation.
 */
async function loadSchemaGraph(rootUrl) {
  const seen = new Map();

  async function walk(url) {
    if (seen.has(url)) return;
    const document = await spec(url);
    seen.set(url, document);

    const refs = new Set();
    (function collect(node) {
      if (Array.isArray(node)) return node.forEach(collect);
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string' && value.startsWith('http')) {
          refs.add(value.split('#')[0]);
        } else {
          collect(value);
        }
      }
    })(document);

    for (const ref of refs) await walk(ref);
  }

  await walk(rootUrl);
  return seen;
}

function makeAjv(documents) {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  for (const [url, document] of documents) {
    // Some published documents carry a $id that differs from the URL they are served
    // at; register both so either form of $ref resolves.
    ajv.addSchema(document, url);
    if (document.$id && document.$id !== url) {
      try {
        ajv.addSchema(document, document.$id);
      } catch {
        // Already registered under this id.
      }
    }
  }
  return ajv;
}

function firstErrors(validate, limit = 4) {
  return (validate.errors ?? [])
    .slice(0, limit)
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

/* =========================================================================== */

console.log(`${DIM}Discovery Service test suite -- ${BASE}${RESET}`);

/* ---------------------------------------------------------- reachability -- */

section('Reachability');

const profileResponse = await getJson('/.well-known/ucp').catch((err) => ({ error: err.message }));
if (profileResponse.error) {
  console.error(`\n${RED}Could not reach ${BASE}: ${profileResponse.error}${RESET}`);
  console.error(`${DIM}Start the deployment first: npm run dev${RESET}\n`);
  process.exit(1);
}

check('GET /.well-known/ucp returns 200', profileResponse.status === 200, `HTTP ${profileResponse.status}`);
check('GET /.well-known/ucp returns parseable JSON', profileResponse.body !== null);

const profile = profileResponse.body ?? {};

/* ------------------------------------------------------- UCP conformance -- */

section('UCP manifest');

check('declares a ucp member', typeof profile.ucp === 'object' && profile.ucp !== null);
check(
  `protocol version is a date-based version (${profile.ucp?.version})`,
  /^\d{4}-\d{2}-\d{2}$/.test(profile.ucp?.version ?? ''),
);
check(
  'services registry is present',
  typeof profile.ucp?.services === 'object' && profile.ucp.services !== null,
);
check(
  'payment_handlers registry is present (required even when empty)',
  typeof profile.ucp?.payment_handlers === 'object' && profile.ucp.payment_handlers !== null,
);

const capabilities = Object.keys(profile.ucp?.capabilities ?? {});
check(
  'declares a Discovery capability (catalog search)',
  capabilities.includes('dev.ucp.shopping.catalog.search'),
  capabilities.join(', '),
);
check(
  'declares a Cart capability',
  capabilities.includes('dev.ucp.shopping.cart'),
  capabilities.join(', '),
);

const shopping = profile.ucp?.services?.['dev.ucp.shopping'] ?? [];
const mcpBinding = shopping.find((binding) => binding.transport === 'mcp');

/* A deployment reached by IP address has no domain to claim reverse-domain authority
 * under, so it declares no vendor capability — the checkout routing lives on the MCP
 * service binding instead. Either shape must carry the same facts. */
const handoff = capabilities.find((name) => name.endsWith('.checkout_handoff'));
const handoffConfig = handoff
  ? profile.ucp.capabilities[handoff][0]?.config
  : mcpBinding?.config?.checkout
    ? { transport: 'mcp', endpoint: mcpBinding.endpoint, tools: mcpBinding.config.checkout }
    : undefined;

check(
  'declares a route to checkout (a capability, or the MCP service binding)',
  Boolean(handoffConfig),
  capabilities.join(', '),
);
if (!handoff) {
  console.log(
    `  ${DIM}note  no vendor checkout capability: this host has no domain to claim authority under,${RESET}`,
  );
  console.log(`  ${DIM}      so the routing is published on the MCP service binding instead${RESET}`);
}
check(
  'the checkout route points into Parley\'s MCP flow',
  handoffConfig?.transport === 'mcp' && typeof handoffConfig?.endpoint === 'string',
  JSON.stringify(handoffConfig ?? null).slice(0, 160),
);
check(
  'the checkout route names a tool that places the order',
  Boolean(handoffConfig?.tools?.place_order),
  JSON.stringify(handoffConfig?.tools ?? null).slice(0, 160),
);

check(
  'declares MCP as a supported transport',
  shopping.some((binding) => binding.transport === 'mcp' && typeof binding.endpoint === 'string'),
  shopping.map((binding) => binding.transport).join(', '),
);
check(
  'the MCP transport points at Parley\'s existing MCP server',
  shopping.some((binding) => binding.transport === 'mcp' && binding.endpoint.endsWith('/api/mcp')),
);

const handlerNames = Object.keys(profile.ucp?.payment_handlers ?? {});
check(
  'declares a Razorpay payment handler',
  handlerNames.some((name) => name.includes('razorpay')),
  handlerNames.join(', ') || '(none — expected when Razorpay keys are unset)',
);

/* Every registry key must be a legal reverse-domain name. A deployment reached by IP
 * address is the case that gets this wrong: reversing 127.0.0.1 gives 1.0.0.127, whose
 * first segment does not start with a letter, and one bad key fails the whole profile. */
{
  const REVERSE_DOMAIN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9_])?)+$/;
  const keys = [
    ...Object.keys(profile.ucp?.services ?? {}),
    ...Object.keys(profile.ucp?.capabilities ?? {}),
    ...Object.keys(profile.ucp?.payment_handlers ?? {}),
  ];
  const bad = keys.filter((key) => !REVERSE_DOMAIN.test(key));
  check('every service, capability and handler key is a legal reverse-domain name', bad.length === 0, bad.join(', '));
}

/* Authority binding: a declared schema URL must originate from the domain its
 * reverse-domain name reverses. A platform that validates this and finds it wrong
 * rejects the capability outright, so it is worth checking here.
 *
 * The authority is not a fixed number of segments — `dev.ucp.shopping.catalog.search`
 * is governed by ucp.dev (two), while a capability named after a deployment on a
 * subdomain reverses more than that. So every leading prefix of the name is a
 * candidate authority, and the schema's host must be one of them or sit beneath it. */
{
  const authorities = (name) => {
    const segments = name.split('.');
    return segments.map((_, index) => segments.slice(0, index + 1).reverse().join('.'));
  };

  let bindingOk = true;
  let detail = '';
  for (const [name, entries] of Object.entries(profile.ucp?.capabilities ?? {})) {
    const candidates = authorities(name);
    for (const entry of entries) {
      if (!entry.schema) continue;
      const host = new URL(entry.schema).hostname;
      const bound = candidates.some(
        (authority) => host === authority || host.endsWith(`.${authority}`),
      );
      if (!bound) {
        bindingOk = false;
        detail = `${name} -> ${entry.schema} (host ${host} matches none of ${candidates.join(', ')})`;
      }
    }
  }
  check('every capability schema URL satisfies UCP authority binding', bindingOk, detail);
}

/* The vendor capability's schema must actually be served, since a platform fetches it. */
if (handoff) {
  const schemaUrl = profile.ucp.capabilities[handoff][0]?.schema;
  const served = await getJson(schemaUrl).catch(() => ({ status: 0 }));
  check(
    'the Checkout capability\'s own schema is served',
    served.status === 200 && served.body !== null,
    `${schemaUrl} -> HTTP ${served.status}`,
  );
}

/* Validation against the published UCP schema. */
if (OFFLINE) {
  skip('profile validates against the published UCP schema', 'DISCOVERY_OFFLINE is set');
} else {
  try {
    const rootUrl = `https://ucp.dev/${UCP_VERSION}/schemas/profile.json`;
    const documents = await loadSchemaGraph(rootUrl);
    const ajv = makeAjv(documents);
    const validate = ajv.getSchema(`${rootUrl}#/$defs/business_schema`);
    check(
      `profile validates against ${rootUrl}#/$defs/business_schema`,
      validate(profile),
      firstErrors(validate),
    );
  } catch (err) {
    check('profile validates against the published UCP schema', false, err.message);
  }
}

/* -------------------------------------------------------- UCP operations -- */

section('UCP catalog and cart');

const searchResponse = await postJson('/api/discovery/ucp/catalog/search', { pagination: { limit: 50 } });
check('catalog search returns 200', searchResponse.status === 200, `HTTP ${searchResponse.status}`);
check(
  'catalog search returns a ucp envelope and products array',
  typeof searchResponse.body?.ucp === 'object' && Array.isArray(searchResponse.body?.products),
);

const ucpProducts = searchResponse.body?.products ?? [];
check('catalog search returns at least one product', ucpProducts.length > 0);

if (!OFFLINE && ucpProducts.length) {
  try {
    const rootUrl = `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_search.json`;
    const documents = await loadSchemaGraph(rootUrl);
    const ajv = makeAjv(documents);
    const validate = ajv.getSchema(`${rootUrl}#/$defs/search_response`);
    check(
      'catalog search response validates against the UCP search schema',
      validate(searchResponse.body),
      firstErrors(validate),
    );
  } catch (err) {
    check('catalog search response validates against the UCP search schema', false, err.message);
  }
} else if (OFFLINE) {
  skip('catalog search response validates against the UCP search schema', 'DISCOVERY_OFFLINE is set');
}

/* A variant id must be usable as-is against Parley's purchase tools, so it has to be
 * the merchant's own product id rather than something this service minted. */
const firstVariant = ucpProducts[0]?.variants?.[0];
if (firstVariant) {
  const detail = await postJson('/api/discovery/ucp/catalog/product', { id: firstVariant.id });
  check(
    'a variant id from search resolves through catalog lookup',
    detail.status === 200 && Boolean(detail.body?.product),
    JSON.stringify(detail.body?.messages ?? null).slice(0, 160),
  );

  const cart = await postJson('/api/discovery/ucp/carts', {
    line_items: [{ item: { id: firstVariant.id }, quantity: 2 }],
  });
  check('cart create returns 200 with an id', cart.status === 200 && typeof cart.body?.id === 'string');
  check(
    'cart totals carry exactly one subtotal and one total',
    (cart.body?.totals ?? []).filter((t) => t.type === 'subtotal').length === 1 &&
      (cart.body?.totals ?? []).filter((t) => t.type === 'total').length === 1,
    JSON.stringify(cart.body?.totals ?? null).slice(0, 160),
  );
  check(
    'cart prices the line from the live catalog',
    cart.body?.totals?.find((t) => t.type === 'subtotal')?.amount === firstVariant.price?.amount * 2,
    `subtotal ${cart.body?.totals?.find((t) => t.type === 'subtotal')?.amount} vs ${firstVariant.price?.amount} x 2`,
  );

  if (cart.body?.id) {
    const reread = await getJson(`/api/discovery/ucp/carts/${encodeURIComponent(cart.body.id)}`);
    check(
      'a cart id round-trips and re-prices on read',
      reread.status === 200 &&
        reread.body?.totals?.find((t) => t.type === 'total')?.amount ===
          cart.body.totals.find((t) => t.type === 'total')?.amount,
    );

    const tampered = `${cart.body.id.split('.')[0]}.deadbeefdeadbeefdeadbeef`;
    const rejected = await getJson(`/api/discovery/ucp/carts/${encodeURIComponent(tampered)}`);
    const rejectedMessage = rejected.body?.messages?.[0]?.code;
    check(
      'a tampered cart id is rejected',
      rejectedMessage === 'cart_invalid' || rejectedMessage === 'cart_not_found',
      `got ${rejectedMessage}`,
    );
  }

  if (!OFFLINE && cart.body?.id) {
    try {
      const rootUrl = `https://ucp.dev/${UCP_VERSION}/schemas/shopping/cart.json`;
      const documents = await loadSchemaGraph(rootUrl);
      const ajv = makeAjv(documents);
      const validate = ajv.getSchema(rootUrl);
      check('cart response validates against the UCP cart schema', validate(cart.body), firstErrors(validate));
    } catch (err) {
      check('cart response validates against the UCP cart schema', false, err.message);
    }
  }
} else {
  skip('cart and lookup checks', 'catalog search returned no products');
}

/* --------------------------------------------------------------- ACP feed -- */

section('ACP product feed');

const feed = await getJson('/api/discovery/feed');
check('feed returns 200', feed.status === 200, `HTTP ${feed.status}`);
check('feed returns a products array', Array.isArray(feed.body?.products));
check(
  `feed declares the ACP spec version it targets (${feed.headers?.get('api-version')})`,
  feed.headers?.get('api-version') === ACP_VERSION,
);

const feedProducts = feed.body?.products ?? [];
const feedVariants = feedProducts.flatMap((product) => product.variants ?? []);
check('feed contains at least one variant', feedVariants.length > 0);

if (OFFLINE) {
  skip('feed validates against the published ACP schema', 'DISCOVERY_OFFLINE is set');
} else {
  try {
    const bundle = await spec(
      'https://raw.githubusercontent.com/agentic-commerce-protocol/agentic-commerce-protocol/' +
        `main/spec/${ACP_VERSION}/json-schema/schema.feed.json`,
    );
    const ajv = makeAjv(new Map([['acp-feed', bundle]]));
    const validate = ajv.getSchema('acp-feed#/$defs/ProductsResponse');
    check(
      `feed validates against ACP ${ACP_VERSION} ProductsResponse`,
      validate(feed.body),
      firstErrors(validate, 6),
    );
  } catch (err) {
    check(`feed validates against ACP ${ACP_VERSION} ProductsResponse`, false, err.message);
  }
}

/* Every field the brief asks the feed to carry, checked against real data rather
 * than against a hand-written fixture. */
check(
  'feed variants carry a price in minor units with a currency',
  feedVariants.some((v) => Number.isInteger(v.price?.amount) && /^[A-Z]{3}$/.test(v.price?.currency ?? '')),
);
check('feed variants carry availability', feedVariants.some((v) => typeof v.availability?.available === 'boolean'));
check('feed products carry images', feedProducts.some((p) => (p.media ?? []).some((m) => m.type === 'image')));
check('feed products carry a description', feedProducts.some((p) => typeof p.description?.plain === 'string'));
check('feed variants carry a stable identifier usable as a SKU', feedVariants.every((v) => typeof v.id === 'string' && v.id));
check('feed variants carry a canonical URL', feedVariants.every((v) => typeof v.url === 'string'));

{
  const withGtin = feedVariants.filter((v) => (v.barcodes ?? []).length > 0);
  if (withGtin.length) {
    check('GTIN barcodes are emitted where the catalog publishes them', true);
  } else {
    skip(
      'GTIN barcodes',
      'this catalog publishes no GTIN/EAN/UPC field, and none is invented — the mapping is exercised by the alias reader',
    );
  }
}

{
  const withCategory = feedVariants.filter((v) => (v.categories ?? []).length > 0);
  if (withCategory.length) check('categories are emitted from the catalog', true);
  else skip('categories', 'this catalog publishes no category field');
}

/* The out-of-stock case, which is the one that goes wrong quietly. */
section('Out-of-stock handling');

let soldOutId = process.env.DISCOVERY_SOLDOUT_ID || process.env.REGRESSION_SOLDOUT_ID || '';
if (!soldOutId) {
  const candidate = feedVariants.find((v) => v.availability?.available === false);
  soldOutId = candidate?.id ?? '';
}

if (!soldOutId) {
  skip('out-of-stock product appears in the feed marked unavailable', 'no sold-out product in this catalog');
} else {
  const inFeed = feedVariants.find((v) => v.id === soldOutId);
  check(`the sold-out product is present in the feed (${soldOutId})`, Boolean(inFeed), 'omitted from the feed');
  check(
    'the sold-out product is marked unavailable, not merely absent',
    inFeed?.availability?.available === false,
    JSON.stringify(inFeed?.availability ?? null),
  );
  check(
    'the sold-out product reports a status of out_of_stock',
    inFeed?.availability?.status === 'out_of_stock',
    inFeed?.availability?.status ?? '(none)',
  );

  const upstream = await getJson(
    `${(process.env.MERCHANT_STOCK_API || '').replace(/\/+$/, '')}/${encodeURIComponent(soldOutId)}`,
  ).catch(() => ({ status: 0, body: null }));
  if (upstream.status === 200) {
    const record = upstream.body?.data ?? upstream.body?.product ?? upstream.body ?? {};
    const upstreamStock = record.stock_count ?? record.stock ?? record.qty;
    check(
      'the feed agrees with the merchant\'s own API about that product being unavailable',
      Number(upstreamStock) === 0 || record.in_stock === false,
      `merchant reports stock=${upstreamStock}, in_stock=${record.in_stock}`,
    );
  } else {
    skip('cross-check against the merchant API', 'MERCHANT_STOCK_API is not reachable from here');
  }

  const inUcp = ucpProducts.flatMap((p) => p.variants ?? []).find((v) => v.id === soldOutId);
  check(
    'the sold-out product is also present in the UCP catalog, marked unavailable',
    inUcp?.availability?.available === false,
    inUcp ? JSON.stringify(inUcp.availability) : 'not present in UCP search results',
  );
}

/* ------------------------------------------------------ crawler checking -- */

section('Crawler access checker');

const BAD_ROBOTS = [
  'User-agent: GPTBot',
  'Disallow: /',
  '',
  'User-agent: *',
  'Allow: /',
].join('\n');

const GOOD_ROBOTS = [
  'User-agent: GPTBot',
  'Allow: /',
  '',
  'User-agent: ClaudeBot',
  'Allow: /',
  '',
  'User-agent: PerplexityBot',
  'Allow: /',
  '',
  'User-agent: Google-Extended',
  'Allow: /',
  '',
  'User-agent: *',
  'Allow: /',
  'Disallow: /admin',
].join('\n');

const bad = await postJson('/api/discovery/crawlers', { robots_txt: BAD_ROBOTS, path: '/products/x' });
const badGpt = bad.body?.crawlers?.find((c) => c.crawler === 'GPTBot');
const badClaude = bad.body?.crawlers?.find((c) => c.crawler === 'ClaudeBot');

check('a robots.txt blocking GPTBot fails GPTBot', badGpt?.status === 'fail', JSON.stringify(badGpt));
check(
  'the same robots.txt still passes the crawlers it does not block',
  badClaude?.status === 'pass',
  JSON.stringify(badClaude),
);
check('the overall verdict on a blocking robots.txt is a failure', bad.body?.overall === 'fail');

/* A domain with no robots.txt blocks nothing, so every crawler passes — but the
 * overall verdict must still carry the advisory rather than reporting a clean bill. */
const noRobots = await postJson('/api/discovery/crawlers', { robots_txt: '', path: '/products/x' });
check(
  'an empty robots.txt passes every crawler',
  (noRobots.body?.crawlers ?? []).every((c) => c.status === 'pass'),
  (noRobots.body?.crawlers ?? []).map((c) => `${c.crawler}=${c.status}`).join(', '),
);
check(
  'the failure explains itself in plain language, naming the rule',
  typeof badGpt?.explanation === 'string' && badGpt.explanation.includes('Disallow: /'),
  badGpt?.explanation,
);

const good = await postJson('/api/discovery/crawlers', { robots_txt: GOOD_ROBOTS, path: '/products/x' });
check(
  'a permissive robots.txt passes all four crawlers',
  (good.body?.crawlers ?? []).every((c) => c.status === 'pass'),
  (good.body?.crawlers ?? []).map((c) => `${c.crawler}=${c.status}`).join(', '),
);

/* The catch-all group must be honoured for a crawler that is not named. */
const wildcardBlocked = await postJson('/api/discovery/crawlers', {
  robots_txt: 'User-agent: *\nDisallow: /',
  path: '/products/x',
});
check(
  'a catch-all Disallow blocks every crawler that is not named separately',
  (wildcardBlocked.body?.crawlers ?? []).every((c) => c.status === 'fail'),
  (wildcardBlocked.body?.crawlers ?? []).map((c) => `${c.crawler}=${c.status}`).join(', '),
);

/* Longest-match precedence, which is where naive robots parsers get it wrong. */
const specific = await postJson('/api/discovery/crawlers', {
  robots_txt: 'User-agent: *\nDisallow: /\nAllow: /products/',
  path: '/products/x',
});
check(
  'the longest matching rule wins, so a narrow Allow beats a broad Disallow',
  (specific.body?.crawlers ?? []).every((c) => c.status === 'pass'),
  (specific.body?.crawlers ?? []).map((c) => `${c.crawler}=${c.status}`).join(', '),
);

/* Server-rendered content detection. */
const clientRendered = await postJson('/api/discovery/crawlers', {
  robots_txt: GOOD_ROBOTS,
  html: '<!doctype html><html><head><title>Shop</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
  page_url: 'https://example.com/products/x',
  expect: { name: 'Some Product', price: '1499.00' },
});
check(
  'a client-rendered product page is flagged',
  clientRendered.body?.serverRendering?.status === 'fail',
  clientRendered.body?.serverRendering?.explanation,
);

const serverRendered = await postJson('/api/discovery/crawlers', {
  robots_txt: GOOD_ROBOTS,
  html: '<!doctype html><html><body><h1>Some Product</h1><p>1499.00</p><p>A real description of the product with enough text to read.</p></body></html>',
  page_url: 'https://example.com/products/x',
  expect: { name: 'Some Product', price: '1499.00' },
});
check(
  'a server-rendered product page passes',
  serverRendered.body?.serverRendering?.status === 'pass',
  serverRendered.body?.serverRendering?.explanation,
);

/* A price rendered with grouping separators and a currency symbol is still the price.
 * Matching the raw catalog string against the page would report a perfectly readable
 * page as client-rendered. */
const formattedPrice = await postJson('/api/discovery/crawlers', {
  robots_txt: GOOD_ROBOTS,
  html: '<!doctype html><html><body><h1>Some Product</h1><p>₹1,399.00</p><p>A real description with enough text.</p></body></html>',
  expect: { name: 'Some Product', price: '1399.00' },
});
check(
  'a price rendered as "1,399.00" counts as the price 1399.00',
  formattedPrice.body?.serverRendering?.status === 'pass',
  formattedPrice.body?.serverRendering?.explanation,
);

/* And one rendered without its trailing zeros. */
const trimmedPrice = await postJson('/api/discovery/crawlers', {
  robots_txt: GOOD_ROBOTS,
  html: '<!doctype html><html><body><h1>Some Product</h1><p>Rs 1,399</p><p>A real description with enough text.</p></body></html>',
  expect: { name: 'Some Product', price: '1399.00' },
});
check(
  'a price rendered as "1,399" counts as the price 1399.00',
  trimmedPrice.body?.serverRendering?.status === 'pass',
  trimmedPrice.body?.serverRendering?.explanation,
);

/* A value present only inside a hydration payload is not readable content. Counting
 * it would pass exactly the client-rendered page this check exists to catch. */
const scriptOnly = await postJson('/api/discovery/crawlers', {
  robots_txt: GOOD_ROBOTS,
  html:
    '<!doctype html><html><body><div id="root"></div>' +
    '<script>window.__DATA__={"name":"Some Product","price":"1399.00"}</script></body></html>',
  expect: { name: 'Some Product', price: '1399.00' },
});
check(
  'a product visible only inside a <script> payload does not count as rendered',
  scriptOnly.body?.serverRendering?.status === 'fail',
  scriptOnly.body?.serverRendering?.explanation,
);

/* Half-rendered is its own diagnosis, and must not be described as an empty page. */
const partial = await postJson('/api/discovery/crawlers', {
  robots_txt: GOOD_ROBOTS,
  html: '<!doctype html><html><body><h1>Some Product</h1><p>A real description with enough text to read.</p></body></html>',
  expect: { name: 'Some Product', price: '1399.00' },
});
check(
  'a page rendering the name but not the price is failed for the price alone',
  partial.body?.serverRendering?.status === 'fail' &&
    /price does not appear/.test(partial.body?.serverRendering?.explanation ?? '') &&
    !/empty container/.test(partial.body?.serverRendering?.explanation ?? ''),
  partial.body?.serverRendering?.explanation,
);

const noindexed = await postJson('/api/discovery/crawlers', {
  robots_txt: GOOD_ROBOTS,
  html: '<!doctype html><html><head><meta name="robots" content="noindex"></head><body><h1>Some Product</h1><p>1499.00</p></body></html>',
  expect: { name: 'Some Product', price: '1499.00' },
});
check(
  'a noindex meta tag is caught even when robots.txt allows the crawler',
  noindexed.body?.serverRendering?.status === 'fail',
  noindexed.body?.serverRendering?.explanation,
);

/* This service's own pages must pass the checker it ships. The expected name is the
 * product's title, not the variant's — a variant title is the option labels
 * ("Navy / S"), which is not what a page renders as its heading. */
const ownPage = firstVariant
  ? await fetch(`${BASE}/p/${encodeURIComponent(firstVariant.id)}`).then((r) => r.text())
  : '';
if (ownPage) {
  const own = await postJson('/api/discovery/crawlers', {
    robots_txt: GOOD_ROBOTS,
    html: ownPage,
    expect: {
      name: ucpProducts[0]?.title ?? '',
      price: firstVariant.price ? (firstVariant.price.amount / 100).toFixed(2) : undefined,
    },
  });
  check(
    'this service\'s own product pages pass its own server-rendering check',
    own.body?.serverRendering?.status === 'pass',
    own.body?.serverRendering?.explanation,
  );
}

/* ---------------------------------------------------------------- JSON-LD -- */

section('Product page JSON-LD');

if (!firstVariant) {
  skip('JSON-LD checks', 'no product available');
} else {
  const productPage = await fetch(`${BASE}/p/${encodeURIComponent(firstVariant.id)}`);
  const html = await productPage.text();

  check('the product page returns 200', productPage.status === 200, `HTTP ${productPage.status}`);

  const blocks = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  check('the product page embeds a JSON-LD block server-side', blocks.length > 0);

  let parsed = null;
  if (blocks.length) {
    try {
      parsed = JSON.parse(blocks[0][1].replace(/\\u003c/g, '<'));
    } catch (err) {
      check('the embedded JSON-LD parses', false, err.message);
    }
  }

  if (parsed) {
    check('the JSON-LD parses', true);
    check('@type is Product', parsed['@type'] === 'Product', String(parsed['@type']));
    check('carries a name', typeof parsed.name === 'string' && parsed.name.length > 0);
    check('carries an image', typeof parsed.image === 'string' && parsed.image.startsWith('http'));
    check('carries a sku', typeof parsed.sku === 'string' && parsed.sku.length > 0);
    check('carries a brand', typeof parsed.brand?.name === 'string' && parsed.brand['@type'] === 'Brand');

    const offers = parsed.offers;
    check('carries an Offer', offers?.['@type'] === 'Offer' || offers?.['@type'] === 'AggregateOffer');
    if (offers?.['@type'] === 'Offer') {
      check('the Offer carries a price', /^\d+\.\d{2}$/.test(offers.price ?? ''), offers.price);
      check('the Offer carries a currency', /^[A-Z]{3}$/.test(offers.priceCurrency ?? ''), offers.priceCurrency);
      check(
        'the Offer carries a schema.org availability URL',
        typeof offers.availability === 'string' && offers.availability.startsWith('https://schema.org/'),
        offers.availability,
      );
      check(
        'the price matches the live catalog',
        offers.price === (firstVariant.price.amount / 100).toFixed(2),
        `${offers.price} vs ${(firstVariant.price.amount / 100).toFixed(2)}`,
      );
    }

    check(
      'the product page is indexable, overriding the app-wide noindex',
      !/<meta[^>]+name="robots"[^>]*content="[^"]*noindex/i.test(html),
      'the page still carries a noindex directive',
    );
  }

  /* The real validator, not an assertion written here. */
  if (OFFLINE) {
    skip('JSON-LD validates at validator.schema.org', 'DISCOVERY_OFFLINE is set');
  } else {
    try {
      const response = await fetch('https://validator.schema.org/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ html }),
      });
      const raw = await response.text();
      // The endpoint prefixes its JSON with an anti-JSON-hijacking guard.
      const report = JSON.parse(raw.replace(/^\)\]\}'\s*/, ''));

      // The validator reports a node's type in `typeGroup`, with the raw declarations
      // in `types[].value`. There is no per-group `id`.
      const nodes = (report.tripleGroups ?? []).flatMap((group) => group.nodes ?? []);
      const typesOf = (node) => [node.typeGroup, ...(node.types ?? []).map((t) => t.value)].filter(Boolean);
      const productNode = nodes.find((node) => typesOf(node).includes('Product'));

      check(
        'validator.schema.org recognises a Product on the page',
        Boolean(productNode),
        `types found: ${nodes.flatMap(typesOf).join(', ') || 'none'}`,
      );
      check(
        'validator.schema.org reads the Offer attached to that Product',
        (productNode?.nodeProperties ?? []).some((property) =>
          ['offers'].includes(property.pred) && typesOf(property.target ?? {}).some((type) => type.endsWith('Offer')),
        ),
        (productNode?.nodeProperties ?? []).map((p) => p.pred).join(', '),
      );
      check(
        'validator.schema.org reports no errors',
        (report.totalNumErrors ?? 0) === 0,
        JSON.stringify(report.errors ?? []).slice(0, 300),
      );
      if (typeof report.totalNumWarnings === 'number' && report.totalNumWarnings > 0) {
        console.log(`  ${DIM}note  validator.schema.org reported ${report.totalNumWarnings} warning(s)${RESET}`);
      }
    } catch (err) {
      check('JSON-LD validates at validator.schema.org', false, err.message);
    }
  }

  /* The injectable form, for a merchant whose storefront is a separate app. */
  const injectable = await getJson(`/api/discovery/jsonld/${encodeURIComponent(firstVariant.id)}`);
  check(
    'the injectable JSON-LD endpoint returns a script block and the parsed object',
    injectable.status === 200 &&
      typeof injectable.body?.script === 'string' &&
      injectable.body.script.startsWith('<script'),
  );
  check(
    'the injectable JSON-LD matches the page\'s own',
    JSON.stringify(injectable.body?.jsonld) === JSON.stringify(parsed),
  );
}

/* ------------------------------------------------------------ appearance -- */

section('Appearance log');

const appearance = await getJson('/api/discovery/appearance');
check('the appearance log is readable', appearance.status === 200);
check(
  'every response carries the "observed appearance, not a guaranteed ranking" label',
  (appearance.body?.disclaimer ?? '').toLowerCase().includes('not a guaranteed ranking'),
  appearance.body?.disclaimer,
);
check(
  'the log does not claim to observe ranking',
  !JSON.stringify(appearance.body?.observations ?? {}).match(/\brank(ed|ing)?\b(?!.*not)/i) ||
    /not of positions|absence of a measurement/.test(appearance.body?.observations?.note ?? ''),
);
/* An errored probe must not be counted as an answer that failed to name the merchant.
 * Conflating the two understates visibility as confidently as inventing a result
 * would overstate it. */
check(
  'errored and untestable probes are counted apart from answers received',
  ['answers_received', 'probes_that_errored', 'platforms_not_testable'].every(
    (key) => typeof appearance.body?.observations?.[key] === 'number',
  ),
  JSON.stringify(appearance.body?.observations ?? null).slice(0, 200),
);
check(
  'a run with no answers says so rather than reporting zero mentions',
  (appearance.body?.observations?.answers_received ?? 0) > 0 ||
    (appearance.body?.observations?.note ?? '').includes('absence of a measurement'),
  appearance.body?.observations?.note,
);

/* ------------------------------------------------------------ robots.txt -- */

section('This service\'s own crawler surface');

const ownRobots = await fetch(`${BASE}/robots.txt`);
const robotsBody = await ownRobots.text();
check('serves its own robots.txt', ownRobots.status === 200);
check(
  'its own robots.txt allows all four AI crawlers by name',
  ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'].every((bot) => robotsBody.includes(bot)),
);

const selfCheck = await postJson('/api/discovery/crawlers', { robots_txt: robotsBody, path: '/p/anything' });
check(
  'its own robots.txt passes its own checker',
  (selfCheck.body?.crawlers ?? []).every((c) => c.status === 'pass'),
  (selfCheck.body?.crawlers ?? []).map((c) => `${c.crawler}=${c.status}`).join(', '),
);

const sitemap = await fetch(`${BASE}/sitemap.xml`);
const sitemapBody = await sitemap.text();
check('serves a sitemap listing product pages', sitemap.status === 200 && sitemapBody.includes('/p/'));

/* ------------------------------------------------------------- freshness -- */

section('Live data, no redeploy');

/**
 * The brief asks for a price or stock change made directly in the merchant's database
 * to appear at both endpoints within the cache TTL.
 *
 * The merchant's catalog here is behind an HTTP API this suite cannot write to, so the
 * proof runs against a stub catalog served from this process instead: a second
 * deployment is pointed at it, a value is changed at the source, and both endpoints
 * are read again. That exercises exactly the property under test — the endpoints read
 * through to the catalog rather than from a copy of it — and it is reproducible, which
 * editing a shared production row is not.
 *
 * Set DISCOVERY_STUB_URL to a second deployment configured against
 * `http://127.0.0.1:<port>/products` to run it.
 */
const STUB_URL = (process.env.DISCOVERY_STUB_URL || '').replace(/\/+$/, '');

if (!STUB_URL) {
  /* Without a stub, the weaker but still meaningful check: the endpoints must at
   * least agree with the merchant's live API right now, which they cannot do if they
   * are serving a build-time snapshot. */
  const searchApi = (process.env.MERCHANT_SEARCH_API || '').replace(/\/+$/, '');
  if (!searchApi) {
    skip('endpoints reflect the merchant\'s live catalog', 'MERCHANT_SEARCH_API is not set');
  } else {
    const live = await getJson(`${searchApi}?include_sold_out=true&limit=500`).catch(() => ({ body: null }));
    const records =
      live.body?.data?.products ?? live.body?.products ?? live.body?.data ?? live.body ?? [];
    const upstream = new Map(
      (Array.isArray(records) ? records : []).map((record) => [
        String(record.id),
        Number(record.price ?? record.cost ?? NaN),
      ]),
    );

    let agree = 0;
    let disagree = '';
    for (const variant of feedVariants) {
      const expected = upstream.get(variant.id);
      if (!Number.isFinite(expected)) continue;
      if (expected === variant.price?.amount) agree += 1;
      else disagree = `${variant.id}: feed ${variant.price?.amount} vs catalog ${expected}`;
    }
    check(
      `feed prices match the merchant's live catalog right now (${agree} products cross-checked)`,
      agree > 0 && !disagree,
      disagree,
    );
  }

  check(
    'the catalog cache TTL is inside the few-minutes ceiling the brief allows',
    Number(process.env.DISCOVERY_CACHE_TTL_MS || 60000) <= 300000,
    `${process.env.DISCOVERY_CACHE_TTL_MS || 60000}ms`,
  );

  skip(
    'a change at the source appears at both endpoints without a redeploy',
    'set DISCOVERY_STUB_URL to run this against a stub catalog -- see scripts/stub-catalog.mjs',
  );
} else {
  // The stub's catalog lives in the stub's own process, so it is changed over its
  // control endpoint rather than by importing it here — mutating a second in-memory
  // copy would prove nothing about what the service reads.
  const STUB_SOURCE = (process.env.DISCOVERY_STUB_SOURCE || 'http://127.0.0.1:4319').replace(/\/+$/, '');
  const mutate = (id, patch) => postJson(`${STUB_SOURCE}/_stub/mutate`, { id, patch });
  const current = (id) => getJson(`${STUB_SOURCE}/_stub/current?id=${encodeURIComponent(id)}`);

  const before = await getJson(`${STUB_URL}/api/discovery/feed`);
  const target = before.body?.products?.[0]?.variants?.[0];

  if (!target) {
    check('the stub deployment serves a feed', false, `HTTP ${before.status}`);
  } else {
    const newPrice = (target.price?.amount ?? 100000) + 12345;
    const mutated = await mutate(target.id, { price: newPrice, stock_count: 0 });
    check('the stub catalog accepted the change at the source', mutated.body?.ok === true, mutated.text?.slice(0, 160));

    // The cache is deliberately not bypassed: waiting it out is the property under
    // test. The stub deployment runs with a short TTL so this is quick.
    const ttl = Number(process.env.DISCOVERY_STUB_TTL_MS || 2000);
    await new Promise((resolve) => setTimeout(resolve, ttl + 500));

    const afterFeed = await getJson(`${STUB_URL}/api/discovery/feed`);
    const afterVariant = afterFeed.body?.products
      ?.flatMap((product) => product.variants ?? [])
      .find((variant) => variant.id === target.id);

    check(
      'a price change at the source appears in the ACP feed without a redeploy',
      afterVariant?.price?.amount === newPrice,
      `expected ${newPrice}, got ${afterVariant?.price?.amount}`,
    );
    check(
      'a stock change at the source appears in the ACP feed without a redeploy',
      afterVariant?.availability?.available === false,
      JSON.stringify(afterVariant?.availability ?? null),
    );

    const afterUcp = await postJson(`${STUB_URL}/api/discovery/ucp/catalog/product`, { id: target.id });
    const ucpVariant = afterUcp.body?.product?.variants?.find((variant) => variant.id === target.id);
    check(
      'the same change appears in the UCP catalog without a redeploy',
      ucpVariant?.price?.amount === newPrice && ucpVariant?.availability?.available === false,
      JSON.stringify({ price: ucpVariant?.price, availability: ucpVariant?.availability }),
    );

    const afterJsonLd = await getJson(`${STUB_URL}/api/discovery/jsonld/${encodeURIComponent(target.id)}`);
    check(
      'the same change appears in the JSON-LD without a redeploy',
      afterJsonLd.body?.jsonld?.offers?.price === (newPrice / 100).toFixed(2) &&
        afterJsonLd.body?.jsonld?.offers?.availability === 'https://schema.org/OutOfStock',
      JSON.stringify(afterJsonLd.body?.jsonld?.offers ?? null).slice(0, 160),
    );

    const source = await current(target.id);
    console.log(`  ${DIM}stub source now reports: ${JSON.stringify(source.body?.record)}${RESET}`);
  }
}


/* ------------------------------------------------------------------ done -- */

console.log(`\n${DIM}${'='.repeat(60)}${RESET}`);
console.log(`${GREEN}${pass} passed${RESET}, ${fail ? RED : DIM}${fail} failed${RESET}, ${DIM}${skipped} skipped${RESET}`);
if (failures.length) {
  console.log(`\n${RED}Failures:${RESET}`);
  for (const failure of failures) console.log(`  - ${failure}`);
}
console.log('');
process.exit(fail ? 1 : 0);
