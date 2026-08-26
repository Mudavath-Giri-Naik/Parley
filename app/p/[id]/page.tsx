import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { publicBaseUrl } from '@/lib/config';
import { formatMoney } from '@/lib/money';
import { merchantName } from '@/lib/discovery/config';
import {
  availability,
  extra,
  groupCatalog,
  groupContaining,
  listCatalog,
  lookupCatalogEntry,
  productUrl,
  type CatalogEntry,
} from '@/lib/discovery/catalog';
import { jsonLdScript, productJsonLd } from '@/lib/discovery/jsonld';

/**
 * A server-rendered product page carrying schema.org Product markup.
 *
 * Every fact on this page — name, price, stock, image — is written into the HTML the
 * server returns, before any JavaScript runs. That is the whole point: it is the
 * shape the crawler checker in this same service tests other pages for, and it would
 * be indefensible to ship a checker that this service's own pages fail.
 *
 * Where a merchant runs their own storefront, that storefront's page is canonical and
 * this one links to it. This page then serves the case the brief actually has to
 * cover: a merchant whose product pages are client-rendered, or who has no product
 * pages an agent can read, gets a readable, marked-up page per product for free.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

async function resolve(id: string): Promise<{ entry: CatalogEntry; siblings: CatalogEntry[] } | null> {
  try {
    const groups = groupCatalog(await listCatalog());
    const group = groupContaining(groups, id);
    if (group) {
      const entry = group.variants.find((candidate) => candidate.product.id === id)!;
      return { entry, siblings: group.variants.filter((candidate) => candidate !== entry) };
    }
  } catch {
    // Fall through to the single-product endpoint below, which may still answer.
  }
  const entry = await lookupCatalogEntry(id).catch(() => null);
  return entry ? { entry, siblings: [] } : null;
}

/**
 * The root layout sets `noindex` for the whole app, which is right for a dashboard
 * and wrong for the one part of it meant to be found. Product pages opt back in.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const resolved = await resolve(id);
  if (!resolved) return { title: 'Product not found', robots: { index: false, follow: false } };

  const { product } = resolved.entry;
  const price = product.price_minor === null ? null : formatMoney(product.price_minor, product.currency);
  // When the merchant runs their own product page, theirs is the canonical one and
  // this page must say so rather than compete with it for the same listing.
  const canonical = productUrl(resolved.entry, publicBaseUrl(await headers()));

  return {
    title: `${product.name} · ${merchantName()}`,
    description: product.description || `${product.name}${price ? ` — ${price}` : ''}`,
    robots: { index: true, follow: true },
    alternates: { canonical },
    openGraph: {
      title: product.name,
      description: product.description ?? undefined,
      images: product.image ? [product.image] : undefined,
      type: 'website',
    },
  };
}

export default async function ProductPage({ params }: Props) {
  const { id } = await params;
  const resolved = await resolve(id);
  if (!resolved) notFound();

  const { entry, siblings } = resolved;
  const base = publicBaseUrl(await headers());
  const { product } = entry;

  const stock = availability(entry);
  const price = product.price_minor === null ? null : formatMoney(product.price_minor, product.currency);
  const canonical = productUrl(entry, base);
  const brand = extra(entry.raw, 'brand') ?? merchantName();
  const category = extra(entry.raw, 'category');
  const sku = extra(entry.raw, 'sku') ?? product.id;

  return (
    <main className="wrap">
      {/* Emitted server-side so a crawler that never runs JavaScript still reads it. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(productJsonLd(entry, base)) }}
      />

      <p className="eyebrow">{merchantName()}</p>
      <h1>{product.name}</h1>

      <p className="lede">
        {price ? <strong>{price}</strong> : <strong>Price on request</strong>}
        {stock ? (
          <>
            {' · '}
            {stock.available
              ? product.stock !== null
                ? `In stock — ${product.stock} available`
                : 'In stock'
              : stock.status === 'out_of_stock'
                ? 'Out of stock'
                : stock.status.replace(/_/g, ' ')}
          </>
        ) : null}
      </p>

      {product.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={product.image}
          alt={product.name}
          width={640}
          height={640}
          style={{ maxWidth: '100%', height: 'auto', borderRadius: 8, margin: '1rem 0' }}
        />
      )}

      {product.description && <p>{product.description}</p>}

      <div className="card">
        <h2>Details</h2>
        <dl className="kv">
          <dt>SKU</dt>
          <dd className="mono">{sku}</dd>
          <dt>Brand</dt>
          <dd>{brand}</dd>
          {category && (
            <>
              <dt>Category</dt>
              <dd>{category}</dd>
            </>
          )}
          {product.size && (
            <>
              <dt>Size</dt>
              <dd>{product.size}</dd>
            </>
          )}
          {product.color && (
            <>
              <dt>Colour</dt>
              <dd>{product.color}</dd>
            </>
          )}
          <dt>Currency</dt>
          <dd>{product.currency}</dd>
        </dl>
      </div>

      {siblings.length > 0 && (
        <div className="card">
          <h2>Other variants</h2>
          <ul>
            {siblings.map((sibling) => {
              const siblingStock = availability(sibling);
              const siblingPrice =
                sibling.product.price_minor === null
                  ? null
                  : formatMoney(sibling.product.price_minor, sibling.product.currency);
              return (
                <li key={sibling.product.id}>
                  <a href={`/p/${encodeURIComponent(sibling.product.id)}`}>
                    {[sibling.product.color, sibling.product.size].filter(Boolean).join(' / ') ||
                      sibling.product.name}
                  </a>
                  {siblingPrice ? ` — ${siblingPrice}` : ''}
                  {siblingStock && !siblingStock.available ? ' (out of stock)' : ''}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="notice">
        <h3>For agents</h3>
        <p style={{ margin: 0 }}>
          This product&apos;s id is <span className="mono">{product.id}</span>. Use it with the MCP
          tools at <span className="mono">{base}/api/mcp</span> to check live stock and buy. Machine
          readable descriptions of this catalog live at{' '}
          <a href="/.well-known/ucp">/.well-known/ucp</a> and{' '}
          <a href="/api/discovery/feed">/api/discovery/feed</a>.
        </p>
      </div>

      {canonical !== `${base}/p/${encodeURIComponent(product.id)}` && (
        <p className="foot">
          The merchant&apos;s own page for this product is <a href={canonical}>{canonical}</a>.
        </p>
      )}
    </main>
  );
}
