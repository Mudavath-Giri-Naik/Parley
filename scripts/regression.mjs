#!/usr/bin/env node
/**
 * Parley regression suite.
 *
 * Runs against a live Parley deployment over its own MCP endpoint, and checks the
 * answers against the merchant's raw API. Nothing here is written for one particular
 * merchant: product ids, names and prices are discovered from the configured catalog
 * at run time, and expectations are derived from the merchant's own responses. Point
 * it at a local instance or at production without editing a line.
 *
 * Usage:
 *   npm run test:regression
 *   PARLEY_MCP_URL=https://your-deployment.example.com/api/mcp npm run test:regression
 *
 * Environment:
 *   PARLEY_MCP_URL        MCP endpoint to exercise. Default http://localhost:3000/api/mcp
 *   PARLEY_API_KEY        Bearer token, if the endpoint is protected.
 *   MERCHANT_SEARCH_API   Read from your .env to cross-check Parley against raw data.
 *   MERCHANT_STOCK_API    As above.
 *   PRICE_UNIT            As above, so the suite knows what the raw prices mean.
 *   REGRESSION_PRODUCT_ID     Pin the in-stock product instead of discovering one.
 *   REGRESSION_SOLDOUT_ID     Pin the out-of-stock product. Some catalogs have none.
 *   PARLEY_STUB_MCP_URL   Optional second Parley instance pointed at a stub merchant,
 *                         which unlocks the refusal and outage checks. See below.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/* ------------------------------------------------------------------ env ---- */

// The suite runs under plain node, which does not read .env files the way Next does.
for (const file of ['.env.local', '.env']) {
  const path = join(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue; // real env always wins
    process.env[key] = rawValue.trim().replace(/^["'](.*)["']$/, '$1');
  }
}

const MCP_URL = process.env.PARLEY_MCP_URL || 'http://localhost:3000/api/mcp';
const STUB_MCP_URL = process.env.PARLEY_STUB_MCP_URL || '';
const SEARCH_API = (process.env.MERCHANT_SEARCH_API || '').replace(/\/+$/, '');
const STOCK_API = (process.env.MERCHANT_STOCK_API || '').replace(/\/+$/, '');
const PRICE_UNIT = (process.env.PRICE_UNIT || 'major').toLowerCase();
const CURRENCY = (process.env.CURRENCY || 'INR').toUpperCase();

/* ---------------------------------------------------------------- report --- */

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

/* ------------------------------------------------------------- transport --- */

async function callOn(url, name, args) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.PARLEY_API_KEY) headers.Authorization = `Bearer ${process.env.PARLEY_API_KEY}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  } catch (err) {
    return { transportError: err.message };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { transportError: `HTTP ${response.status}, non-JSON response` };
  }
  if (body.error) return { rpcError: body.error.message };
  const text = body.result?.content?.[0]?.text ?? '';
  if (body.result?.isError) return { toolError: text };
  try {
    return JSON.parse(text);
  } catch {
    return { toolError: text };
  }
}

const call = (name, args) => callOn(MCP_URL, name, args);

/** Minimal, independent envelope unwrapping so the suite does not lean on Parley's. */
function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['products', 'items', 'data', 'results', 'records', 'rows']) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      for (const nested of ['products', 'items', 'data', 'results', 'records', 'rows']) {
        if (Array.isArray(value[nested])) return value[nested];
      }
    }
  }
  return [];
}

function unwrapObject(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of ['product', 'item', 'data', 'result']) {
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) {
      return payload[key];
    }
  }
  return payload;
}

function rawField(record, names) {
  for (const name of names) {
    if (record?.[name] !== undefined && record[name] !== null && record[name] !== '') {
      return record[name];
    }
  }
  return undefined;
}

/** Converts a raw merchant price into minor units the way the deployment is configured. */
function toMinor(rawPrice) {
  const numeric = typeof rawPrice === 'number' ? rawPrice : Number(String(rawPrice).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(numeric)) return null;
  return Math.round(PRICE_UNIT === 'minor' ? numeric : numeric * 100);
}

async function fetchRaw(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  return response.json();
}

/* ------------------------------------------------------------- fixtures --- */

console.log(`\nParley regression suite`);
console.log(`${DIM}  endpoint : ${MCP_URL}`);
console.log(`  catalog  : ${SEARCH_API || '(MERCHANT_SEARCH_API not set)'}`);
console.log(`  prices   : ${PRICE_UNIT} units, ${CURRENCY}${RESET}`);

if (!SEARCH_API || !STOCK_API) {
  console.error(
    `\n${RED}MERCHANT_SEARCH_API and MERCHANT_STOCK_API must be set so the suite can cross-check Parley against raw data.${RESET}\n`,
  );
  process.exit(2);
}

const rawCatalog = unwrapList(await fetchRaw(SEARCH_API));
if (!rawCatalog.length) {
  console.error(`\n${RED}The configured catalog returned no products; nothing to test against.${RESET}\n`);
  process.exit(2);
}

function rawStock(record) {
  const value = rawField(record, [
    'stock', 'qty', 'quantity', 'inventory', 'stock_count', 'stockCount', 'available_qty', 'units',
  ]);
  return typeof value === 'number' ? value : Number.isFinite(Number(value)) ? Number(value) : null;
}

const rawInStock =
  rawCatalog.find((p) => process.env.REGRESSION_PRODUCT_ID
    ? String(rawField(p, ['id', 'product_id', 'sku', 'slug', '_id'])) === process.env.REGRESSION_PRODUCT_ID
    : (rawStock(p) ?? 1) > 0);

/**
 * Many catalogs hide sold-out products from the default listing, so a pinned
 * fixture is fetched directly rather than looked for in the search results.
 */
async function resolveSoldOut() {
  const pinned = process.env.REGRESSION_SOLDOUT_ID;
  if (!pinned) return rawCatalog.find((p) => rawStock(p) === 0) ?? null;

  const inListing = rawCatalog.find(
    (p) => String(rawField(p, ['id', 'product_id', 'sku', 'slug', '_id'])) === pinned,
  );
  if (inListing) return inListing;

  const url = STOCK_API.includes('{id}')
    ? STOCK_API.replaceAll('{id}', encodeURIComponent(pinned))
    : `${STOCK_API}/${encodeURIComponent(pinned)}`;
  try {
    return unwrapObject(await fetchRaw(url));
  } catch {
    return null;
  }
}

const rawSoldOut = await resolveSoldOut();

if (!rawInStock) {
  console.error(`\n${RED}No in-stock product found in the catalog to test against.${RESET}\n`);
  process.exit(2);
}

const PRODUCT_ID = String(rawField(rawInStock, ['id', 'product_id', 'sku', 'slug', '_id']));
const PRODUCT_NAME = rawField(rawInStock, ['name', 'title', 'product_name', 'label']);
const PRODUCT_PRICE_MINOR = toMinor(rawField(rawInStock, ['price', 'cost', 'amount', 'unit_price', 'mrp']));
const SOLDOUT_ID = rawSoldOut ? String(rawField(rawSoldOut, ['id', 'product_id', 'sku', 'slug', '_id'])) : null;

console.log(`${DIM}  fixture  : ${PRODUCT_NAME} (${PRODUCT_ID}) at ${PRODUCT_PRICE_MINOR} minor units`);
console.log(`  sold out : ${SOLDOUT_ID ?? 'none in this catalog'}${RESET}`);

const buyer = `regression-${Date.now()}@example.com`;

/* ----------------------------------------------------------------- 1-10 --- */

section('catalog and field mapping');
const searchTerm = String(PRODUCT_NAME || '').split(' ')[0] || 'a';
const search = await call('search_products', { query: searchTerm, limit: 20 });
check('search returns products', Array.isArray(search.products) && search.products.length > 0, search.toolError);
check('reported count matches the array', search.count === search.products?.length);
const found = search.products?.find((p) => p.id === PRODUCT_ID);
check('the known product appears in results', Boolean(found), `looked for ${PRODUCT_ID}`);
check('price normalized to minor units', found?.price_minor === PRODUCT_PRICE_MINOR, `expected ${PRODUCT_PRICE_MINOR}, got ${found?.price_minor}`);
check('price_display is formatted', typeof found?.price_display === 'string' && found.price_display.includes('.'));
check('currency reported', found?.currency === CURRENCY, `got ${found?.currency}`);
check('stock resolved through the alias table', typeof found?.stock === 'number' || found?.stock === null);
check('in-stock item flagged in_stock', found?.in_stock === true);
check('name resolved through the alias table', found?.name === PRODUCT_NAME, `expected ${PRODUCT_NAME}, got ${found?.name}`);
check('every result carries an id', search.products?.every((p) => typeof p.id === 'string' && p.id.length > 0));

/* ---------------------------------------------------------------- 11-14 --- */

section('product details');
const details = await call('get_product_details', { product_id: PRODUCT_ID });
check('details price matches the raw catalog', details.price_minor === PRODUCT_PRICE_MINOR, `expected ${PRODUCT_PRICE_MINOR}, got ${details.price_minor}`);
check('details name matches the raw catalog', details.name === PRODUCT_NAME);
check('details echo the requested id', details.id === PRODUCT_ID);
check('details include a currency', typeof details.currency === 'string' && details.currency.length === 3);

/* ---------------------------------------------------------------- 15-20 --- */

section('live stock');
const stockOk = await call('check_stock', { product_id: PRODUCT_ID });
check('in-stock item can be fulfilled', stockOk.can_fulfill === true, `got ${stockOk.can_fulfill}`);
check('in-stock item reports availability', stockOk.in_stock === true);
check('stock check is timestamped, never cached', typeof stockOk.checked_at === 'string');

if (SOLDOUT_ID) {
  const stockOut = await call('check_stock', { product_id: SOLDOUT_ID });
  check('sold-out item reports in_stock false', stockOut.in_stock === false, `got ${stockOut.in_stock}`);
  check('sold-out item reports zero stock', stockOut.stock === 0, `got ${stockOut.stock}`);
  check('sold-out item cannot be fulfilled', stockOut.can_fulfill === false);
} else {
  skip('sold-out item reports in_stock false', 'no zero-stock product in this catalog');
  skip('sold-out item reports zero stock', 'no zero-stock product in this catalog');
  skip('sold-out item cannot be fulfilled', 'no zero-stock product in this catalog');
}

/* ------------------------------------------------------------------- 21 --- */

section('unknown product');
const missing = await call('get_product_details', { product_id: 'regression-no-such-product' });
check('unknown product is a clean tool error, not a crash', typeof missing.toolError === 'string' && missing.toolError.length > 0);

/* ---------------------------------------------------------------- 22-26 --- */

section('order refused for lack of stock');
if (SOLDOUT_ID) {
  const oos = await call('create_order_and_pay', {
    product_id: SOLDOUT_ID,
    customer_name: 'Regression Buyer',
    customer_email: buyer,
  });
  check('out-of-stock order is blocked', oos.outcome === 'blocked', `got ${oos.outcome}`);
  check('out-of-stock is NOT reclassified as an outage', oos.outcome !== 'unavailable');
  check('customer is told it is out of stock', /out of stock/i.test(oos.message || ''), oos.message);
  check('nothing is charged for an out-of-stock item', !oos.payment_link);
  check('agent is told to offer an alternative', /alternative/i.test(oos.suggestion || ''));
} else {
  for (const name of [
    'out-of-stock order is blocked',
    'out-of-stock is NOT reclassified as an outage',
    'customer is told it is out of stock',
    'nothing is charged for an out-of-stock item',
    'agent is told to offer an alternative',
  ]) skip(name, 'no zero-stock product in this catalog');
}

/* ---------------------------------------------------------------- 27-31 --- */

section('order accepted');
const accepted = await call('create_order_and_pay', {
  product_id: PRODUCT_ID,
  customer_name: 'Regression Buyer',
  customer_email: buyer,
});
check('an accepted order reaches the payment step', accepted.outcome === 'awaiting_approval', `got ${accepted.outcome}: ${accepted.message || accepted.toolError}`);
check('a payment link is issued', typeof accepted.payment_link === 'string' && accepted.payment_link.startsWith('http'));
check('an order id is captured', typeof accepted.order_id === 'string' && accepted.order_id.length > 0);
check('the charged amount matches the catalog price', accepted.amount_minor === PRODUCT_PRICE_MINOR, `expected ${PRODUCT_PRICE_MINOR}, got ${accepted.amount_minor}`);
check('an unmandated purchase requires human approval', accepted.requires_human_approval === true);

/* ---------------------------------------------------------------- 32-35 --- */

section('discount ceiling');
const cap = Number(process.env.MAX_DISCOUNT_PERCENT ?? 10);
const greedy = Math.min(100, cap + 40);
const discounted = await call('create_order_and_pay', {
  product_id: PRODUCT_ID,
  customer_name: 'Regression Buyer',
  customer_email: buyer,
  discount_percent: greedy,
});
check(`a ${greedy}% request is clamped to the ${cap}% ceiling`, discounted.discount_percent === cap, `got ${discounted.discount_percent}`);
check('the clamped amount is priced correctly', discounted.amount_minor === Math.round(PRODUCT_PRICE_MINOR * (1 - cap / 100)), `expected ${Math.round(PRODUCT_PRICE_MINOR * (1 - cap / 100))}, got ${discounted.amount_minor}`);
check('the list price is unchanged by the clamp', discounted.list_price_minor === PRODUCT_PRICE_MINOR);
check('a clamped order still reaches payment', discounted.outcome === 'awaiting_approval');

/* ---------------------------------------------------------------- 36-44 --- */

section('spend mandates');
const mandateRef = `regression-mandate-${Date.now()}@example.com`;
const capMinor = Math.max(PRODUCT_PRICE_MINOR * 3, 1000);

const before = await call('check_mandate', { customer_ref: mandateRef });
check('a fresh customer has no mandate', before.has_mandate === false, before.toolError);
const created = await call('create_mandate', { customer_ref: mandateRef, cap_minor: capMinor, note: 'regression suite' });
check('a mandate can be created', created.cap_minor === capMinor && created.status === 'active', created.toolError);
check('a new mandate starts unspent', created.spent_minor === 0);

const underCap = await call('create_order_and_pay', {
  product_id: PRODUCT_ID,
  customer_name: 'Regression Buyer',
  customer_email: mandateRef,
  customer_ref: mandateRef,
  use_mandate: true,
});
check('a purchase inside the cap completes', underCap.outcome === 'completed', `got ${underCap.outcome}`);
check('a mandated purchase needs no human', underCap.requires_human_approval === false);
check('the cap is decremented by the amount charged', underCap.mandate?.remaining_minor === capMinor - PRODUCT_PRICE_MINOR, `expected ${capMinor - PRODUCT_PRICE_MINOR}, got ${underCap.mandate?.remaining_minor}`);

const overCap = await call('create_order_and_pay', {
  product_id: PRODUCT_ID,
  customer_name: 'Regression Buyer',
  customer_email: mandateRef,
  customer_ref: mandateRef,
  use_mandate: true,
  quantity: 50,
});
check('a purchase over the cap falls back to approval', overCap.requires_human_approval === true, `got ${overCap.outcome}`);
check('a purchase over the cap does not complete silently', overCap.outcome !== 'completed');

const afterSpend = await call('check_mandate', { customer_ref: mandateRef });
check('the mandate records only the permitted spend', afterSpend.spent_minor === PRODUCT_PRICE_MINOR, `expected ${PRODUCT_PRICE_MINOR}, got ${afterSpend.spent_minor}`);

/* ---------------------------------------------------------------- 45-48 --- */

section('audit trail');
const trail = await call('get_audit_trail', { limit: 50 });
check('actions are recorded', trail.count > 0, trail.toolError);
check('every entry carries plain-language reasoning', trail.entries?.every((e) => typeof e.reasoning === 'string' && e.reasoning.trim().length > 0));
check('the order attempts are recorded', trail.entries?.some((e) => e.action === 'create_order_and_pay'));
check('a healthy merchant produces no outage entries', !trail.entries?.some((e) => e.action === 'merchant_unavailable'));

/* --------------------------------------------------- optional stub checks -- */

section('merchant refusal and outage handling (needs PARLEY_STUB_MCP_URL)');
if (STUB_MCP_URL) {
  const stubProduct = process.env.REGRESSION_STUB_PRODUCT_ID || PRODUCT_ID;
  const refused = await callOn(STUB_MCP_URL, 'create_order_and_pay', {
    product_id: stubProduct,
    customer_name: 'Regression Buyer',
    customer_email: buyer,
  });
  const isRefusal = refused.outcome === 'failed' || refused.outcome === 'blocked';
  check('a body-level refusal (ok:false on HTTP 200) is not treated as accepted', isRefusal, `got ${refused.outcome}`);
  check('a refused order is never sent for payment', !refused.payment_link);

  const outageUrl = process.env.PARLEY_OUTAGE_MCP_URL;
  if (outageUrl) {
    const outage = await callOn(outageUrl, 'create_order_and_pay', {
      product_id: stubProduct,
      customer_name: 'Regression Buyer',
      customer_email: buyer,
    });
    check('a 5xx is reported as an outage, not as out of stock', outage.outcome === 'unavailable', `got ${outage.outcome}`);
    // The message may legitimately mention stock in order to deny it ("has not been
    // reported as out of stock"), so only an affirmative claim counts as a failure.
    check(
      'the outage message does not claim the item is sold out',
      !/\bis (out of stock|sold out|unavailable)\b/i.test(outage.message || ''),
      outage.message,
    );
    check('the outage tells the customer to try again', /try again|temporarily/i.test(`${outage.message} ${outage.suggestion}`));
    check('nothing is charged during an outage', !outage.payment_link);
  } else {
    for (const name of [
      'a 5xx is reported as an outage, not as out of stock',
      'the outage message does not claim the item is sold out',
      'the outage tells the customer to try again',
      'nothing is charged during an outage',
    ]) skip(name, 'set PARLEY_OUTAGE_MCP_URL to an instance whose order API returns 5xx');
  }
} else {
  for (const name of [
    'a body-level refusal (ok:false on HTTP 200) is not treated as accepted',
    'a refused order is never sent for payment',
    'a 5xx is reported as an outage, not as out of stock',
    'the outage message does not claim the item is sold out',
    'the outage tells the customer to try again',
    'nothing is charged during an outage',
  ]) skip(name, 'set PARLEY_STUB_MCP_URL to a Parley instance pointed at a stub merchant');
}

/* ---------------------------------------------------------------- summary -- */

const total = pass + fail;
console.log(`\n${'='.repeat(56)}`);
console.log(
  `  ${fail ? RED : GREEN}${pass}/${total} passed${RESET}` +
    (fail ? `, ${RED}${fail} failed${RESET}` : '') +
    (skipped ? `${DIM}, ${skipped} skipped${RESET}` : ''),
);
if (failures.length) {
  console.log(`\n  ${RED}Failures:${RESET}`);
  for (const failure of failures) console.log(`   - ${failure}`);
}
console.log(`${'='.repeat(56)}\n`);

process.exit(fail ? 1 : 0);
