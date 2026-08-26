#!/usr/bin/env node
/**
 * A stub merchant catalog, for proving that the Discovery Service reads through.
 *
 * The claim under test is that the manifest, the feed and the JSON-LD hold no copy of
 * the product data — that a price or stock change at the source shows up at every
 * endpoint within the cache TTL, with no redeploy. Proving that needs a catalog whose
 * values can be changed on demand, which a shared production storefront is not.
 *
 * So: this serves a tiny catalog in the same response envelope a real storefront uses,
 * with an in-memory record that the test suite mutates mid-run. A second Discovery
 * Service instance is pointed at it, and the change is observed arriving.
 *
 * Nothing here is merchant data. The products are generic placeholders and exist only
 * for the duration of the process.
 *
 *   node scripts/stub-catalog.mjs            # serve on :4319
 *   PORT=5000 node scripts/stub-catalog.mjs
 *
 * Then, in another terminal:
 *
 *   MERCHANT_NAME="Stub" \
 *   MERCHANT_SEARCH_API=http://127.0.0.1:4319/products \
 *   MERCHANT_STOCK_API=http://127.0.0.1:4319/products \
 *   MERCHANT_ORDER_API=http://127.0.0.1:4319/orders \
 *   PRICE_UNIT=minor DISCOVERY_CACHE_TTL_MS=2000 PORT=3100 npm run dev
 *
 *   DISCOVERY_STUB_URL=http://127.0.0.1:3100 npm run test:discovery
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** The stub's catalog. Deliberately mutable; that is the whole point of the file. */
const catalog = new Map([
  [
    'stub-001',
    {
      id: 'stub-001',
      name: 'Placeholder Item One',
      description: 'A stub product used to prove the discovery endpoints read through to the catalog.',
      price: 149900,
      size: 'M',
      color: 'Blue',
      category: 'Placeholders',
      image_url: 'https://example.com/stub-001.jpg',
      stock_count: 5,
      status: 'available',
    },
  ],
  [
    'stub-002',
    {
      id: 'stub-002',
      name: 'Placeholder Item Two',
      description: 'A second stub product, permanently out of stock.',
      price: 99900,
      size: 'L',
      color: 'Green',
      category: 'Placeholders',
      image_url: 'https://example.com/stub-002.jpg',
      stock_count: 0,
      status: 'sold_out',
    },
  ],
]);

/** Changes a product at the source. Imported by the test suite. */
export function mutate(id, patch) {
  const record = catalog.get(id);
  if (!record) throw new Error(`stub catalog has no product "${id}"`);
  Object.assign(record, patch);
  if (patch.stock_count !== undefined) {
    record.status = patch.stock_count > 0 ? 'available' : 'sold_out';
  }
  return { ...record };
}

/** Reads a product back, for reporting what the source now says. */
export function current(id) {
  const record = catalog.get(id);
  return record ? { id: record.id, price: record.price, stock_count: record.stock_count } : null;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // No caching anywhere but the service under test, or the test proves nothing.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

export function startStub(port = Number(process.env.PORT || 4319)) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);

    /* The control surface the test suite drives. It has to live here rather than in
     * the test process: the catalog is in *this* process's memory, and mutating a
     * second copy in the test would prove nothing about what the service reads. */
    if (parts[0] === '_stub') {
      if (parts[1] === 'mutate' && req.method === 'POST') {
        const { id, patch } = await readBody(req);
        try {
          return send(res, 200, { ok: true, record: mutate(id, patch ?? {}) });
        } catch (err) {
          return send(res, 404, { ok: false, error: err.message });
        }
      }
      if (parts[1] === 'current') {
        return send(res, 200, { ok: true, record: current(url.searchParams.get('id') ?? '') });
      }
      return send(res, 404, { ok: false, error: 'not found' });
    }

    if (parts[0] !== 'products') return send(res, 404, { ok: false, error: 'not found' });

    if (parts.length === 1) {
      const includeSoldOut = /^(1|true|yes)$/i.test(url.searchParams.get('include_sold_out') ?? '');
      const products = [...catalog.values()].filter(
        (record) => includeSoldOut || record.stock_count > 0,
      );
      // The same envelope shape a real storefront uses, so the normalizer under test
      // is exercised rather than bypassed.
      return send(res, 200, { ok: true, data: { count: products.length, products } });
    }

    const record = catalog.get(decodeURIComponent(parts[1]));
    if (!record) return send(res, 404, { ok: false, error: 'not found' });
    return send(res, 200, { ok: true, data: { ...record, in_stock: record.stock_count > 0 } });
  });

  server.listen(port, '127.0.0.1');
  return server;
}

// Started directly rather than imported: serve until interrupted. pathToFileURL is
// what makes this correct on Windows, where a hand-built `file://` prefix produces
// two slashes where the URL form has three.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4319);
  startStub(port);
  console.log(`Stub catalog serving on http://127.0.0.1:${port}/products`);
  console.log('Products:', [...catalog.keys()].join(', '));
}
