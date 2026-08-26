/**
 * Crawler access checker.
 *
 * Two questions decide whether an AI crawler can see a merchant's products at all,
 * and a merchant usually cannot answer either from their own browser:
 *
 *   1. Does robots.txt let the crawler in? Blocking GPTBot or ClaudeBot is often
 *      inherited from a template or a CDN default rather than chosen.
 *   2. Is there anything in the HTML to read? A crawler that does not execute
 *      JavaScript sees the server's response, and a client-rendered product page
 *      serves it an empty container.
 *
 * robots.txt parsing follows RFC 9309: group by user-agent, most specific group wins,
 * longest matching rule wins within a group, and Allow beats Disallow on a tie.
 * Matching is deliberately strict about one thing the RFC is explicit on — a crawler
 * obeys the group whose name it matches case-insensitively, and only falls back to `*`
 * when no group names it.
 */

import { discoveryConfig } from './config';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';

export interface CrawlerVerdict {
  crawler: string;
  status: CheckStatus;
  /** Plain language, for a merchant who has never read a robots.txt. */
  explanation: string;
  matchedGroup?: string;
  matchedRule?: string;
}

export interface RenderVerdict {
  status: CheckStatus;
  explanation: string;
  url?: string;
  htmlBytes?: number;
  visibleTextLength?: number;
  foundInHtml?: { name: boolean; price: boolean };
  metaRobots?: string;
  xRobotsTag?: string;
}

export interface CrawlerReport {
  checkedAt: string;
  robots: {
    url?: string;
    status: CheckStatus;
    explanation: string;
    httpStatus?: number;
  };
  crawlers: CrawlerVerdict[];
  serverRendering: RenderVerdict;
  summary: { pass: number; fail: number; warn: number; unknown: number };
  overall: CheckStatus;
}

/* ------------------------------------------------------------ robots.txt --- */

interface RobotsRule {
  allow: boolean;
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

/** Parses robots.txt into groups. Unknown directives are ignored, as the RFC requires. */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // Consecutive User-agent lines share one group; the first rule line closes the
  // agent list, so a later User-agent starts a new group.
  let acceptingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || !acceptingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        acceptingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    if (!current) continue;
    acceptingAgents = false;
    current.rules.push({ allow: field === 'allow', path: value });
  }

  return groups.filter((group) => group.agents.length > 0);
}

/** True when `path` matches a robots rule pattern, honouring `*` and `$`. */
function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const anchored = escaped.endsWith('$') ? `^${escaped}` : `^${escaped}`;
  try {
    return new RegExp(anchored).test(path);
  } catch {
    return path.startsWith(pattern);
  }
}

/**
 * Decides whether one crawler may fetch one path.
 *
 * Longest matching rule wins; on equal length, Allow wins. An empty Disallow value
 * means "nothing is disallowed" and is not a match, which is how `Disallow:` is used
 * to open a site up.
 */
export function robotsVerdict(
  groups: RobotsGroup[],
  crawler: string,
  path: string,
): { allowed: boolean; group?: string; rule?: string } {
  const name = crawler.toLowerCase();

  const named = groups.filter((group) => group.agents.includes(name));
  const wildcard = groups.filter((group) => group.agents.includes('*'));
  const applicable = named.length ? named : wildcard;
  if (!applicable.length) return { allowed: true };

  const groupLabel = named.length ? crawler : '*';
  const rules = applicable.flatMap((group) => group.rules);

  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!rule.path) continue; // `Disallow:` with no value disallows nothing.
    if (!matchesPattern(rule.path, path)) continue;
    if (!best) {
      best = rule;
      continue;
    }
    if (rule.path.length > best.path.length) best = rule;
    else if (rule.path.length === best.path.length && rule.allow) best = rule;
  }

  if (!best) return { allowed: true, group: groupLabel };
  return {
    allowed: best.allow,
    group: groupLabel,
    rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}`,
  };
}

/* ------------------------------------------------- server-rendered check --- */

/** Strips the parts of a document a non-executing crawler gets nothing from. */
function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Removes the grouping separators inside numbers so a rendered price can be compared
 * with a plain one. A page showing "₹1,399.00" is showing the price; matching the raw
 * string "1399.00" against it would say otherwise, and report a perfectly readable
 * page as client-rendered.
 */
function normalizeNumbers(text: string): string {
  return text.replace(/(\d)[,\s  ](?=\d{3}(?!\d))/g, '$1');
}

/**
 * The forms a price may legitimately take on a page. A catalog price of "1399.00" is
 * commonly rendered without its trailing zeros, so a bare integer counts as found.
 */
function priceCandidates(price: string): string[] {
  const trimmed = price.trim();
  const candidates = new Set([trimmed]);
  const withoutZeroFraction = trimmed.replace(/\.0+$/, '');
  if (withoutZeroFraction) candidates.add(withoutZeroFraction);
  return [...candidates].filter(Boolean);
}

function metaRobots(html: string): string | undefined {
  const match = html.match(/<meta[^>]+name=["']robots["'][^>]*>/i);
  if (!match) return undefined;
  return match[0].match(/content=["']([^"']*)["']/i)?.[1];
}

export interface RenderProbe {
  url: string;
  html: string;
  xRobotsTag?: string;
  /** Values that must appear in the server's HTML for the page to be readable. */
  expect?: { name?: string; price?: string };
}

/**
 * Judges whether a product page is readable without running JavaScript.
 *
 * The test is not "is there any text" — a client-rendered app still ships a header
 * and a footer. It is whether the product's own name and price are in the bytes the
 * server sent. That is the thing a crawler needs and the thing a JS-only page omits.
 */
export function assessRendering(probe: RenderProbe): RenderVerdict {
  const text = visibleText(probe.html);
  const meta = metaRobots(probe.html);
  const noindex = /noindex/i.test(meta ?? '') || /noindex/i.test(probe.xRobotsTag ?? '');

  // Matched against the readable text, not the raw HTML. A value that appears only
  // inside a <script> — a hydration payload, a JSON island — is not content a
  // non-executing crawler can read, and counting it would pass a page that fails.
  const name = probe.expect?.name;
  const price = probe.expect?.price;
  const searchable = normalizeNumbers(text).toLowerCase();
  const foundName = name ? searchable.includes(name.trim().toLowerCase()) : false;
  const foundPrice = price
    ? priceCandidates(price).some((candidate) => searchable.includes(candidate.toLowerCase()))
    : false;

  const base = {
    url: probe.url,
    htmlBytes: probe.html.length,
    visibleTextLength: text.length,
    foundInHtml: { name: foundName, price: foundPrice },
    metaRobots: meta,
    xRobotsTag: probe.xRobotsTag,
  };

  if (noindex) {
    return {
      ...base,
      status: 'fail',
      explanation:
        `This page tells crawlers not to index it (${meta ?? probe.xRobotsTag}). Whatever ` +
        'robots.txt allows, a crawler that honours this will keep the page out of its index. ' +
        'Remove the noindex directive from product pages you want found.',
    };
  }

  if (!name && !price) {
    return {
      ...base,
      status: text.length > 200 ? 'pass' : 'warn',
      explanation:
        text.length > 200
          ? `The server returned ${text.length} characters of readable text without running any JavaScript.`
          : 'The server returned very little readable text, and no product name or price was supplied to check for.',
    };
  }

  if (foundName && (foundPrice || !price)) {
    return {
      ...base,
      status: 'pass',
      explanation:
        'The product name and price are present in the HTML the server returned, so a crawler ' +
        'that does not run JavaScript can still read this page.',
    };
  }

  const missing = [!foundName ? 'name' : null, price && !foundPrice ? 'price' : null]
    .filter(Boolean)
    .join(' and ');

  // Missing everything and missing one field are different diagnoses, and telling a
  // merchant their page is an empty container when half of it renders is both wrong
  // and unhelpful about what to fix.
  const nothingRendered = !foundName && (!price || !foundPrice);

  return {
    ...base,
    status: 'fail',
    explanation: nothingRendered
      ? `Neither the product name nor its price appears in the readable text the server returned — ` +
        `only ${text.length} characters came back. This page is filled in by JavaScript after it loads, ` +
        'so a crawler that does not execute scripts sees an empty container. Server-render the product ' +
        'details, or serve them to crawlers some other way.'
      : `The product ${missing} does not appear in the readable text the server returned, though the ` +
        `rest of the page does (${text.length} characters). That part of the page is filled in by ` +
        'JavaScript after it loads, so a crawler that does not execute scripts sees the product but not ' +
        `its ${missing}. Server-render that field, or add the JSON-LD block from this service to the page.`,
  };
}

/* ------------------------------------------------------------- the check --- */

export interface CheckOptions {
  /** Origin to check. Defaults to the merchant storefront derived from the catalog API. */
  origin?: string;
  /** Supply robots.txt directly instead of fetching it. Used by the test suite. */
  robotsText?: string;
  /** Path a crawler would need to reach. Defaults to the storefront root. */
  path?: string;
  /** Supply a page instead of fetching one. */
  page?: RenderProbe;
  crawlers?: string[];
  fetchTimeoutMs?: number;
}

async function fetchText(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; body: string; headers: Headers } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      // Identifying honestly matters here: a site that varies its response by
      // user-agent should be measured on what it serves this checker, not on a
      // crawler impersonation.
      headers: { 'User-Agent': 'Parley-Discovery/1.0 (+crawler-access-check)' },
    });
    return { status: response.status, body: await response.text(), headers: response.headers };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkCrawlerAccess(options: CheckOptions = {}): Promise<CrawlerReport> {
  const origin = (options.origin ?? discoveryConfig.storefrontOrigin)?.replace(/\/+$/, '');
  const crawlers = options.crawlers ?? discoveryConfig.crawlers;
  const path = options.path ?? '/';
  const timeout = options.fetchTimeoutMs ?? 15_000;
  const checkedAt = new Date().toISOString();

  /* robots.txt */
  let robotsText = options.robotsText;
  let robotsUrl: string | undefined;
  let robotsHttpStatus: number | undefined;
  let robotsStatus: CheckStatus = 'unknown';
  let robotsExplanation = '';

  if (robotsText !== undefined) {
    robotsStatus = 'pass';
    robotsExplanation = 'Checked against the robots.txt supplied to this check.';
  } else if (!origin) {
    robotsExplanation =
      'No storefront origin is configured, so robots.txt could not be located. Set STOREFRONT_URL.';
  } else {
    robotsUrl = `${origin}/robots.txt`;
    const result = await fetchText(robotsUrl, timeout);
    if ('error' in result) {
      robotsExplanation = `robots.txt could not be fetched: ${result.error}`;
    } else {
      robotsHttpStatus = result.status;
      if (result.status === 404 || result.status === 410) {
        robotsText = '';
        robotsStatus = 'warn';
        robotsExplanation =
          'There is no robots.txt at this domain. Nothing is blocked, which is the outcome you ' +
          'want, but it also means nothing is stated: add one so the rules are explicit and cannot ' +
          'be changed by a platform default later.';
      } else if (result.status >= 400) {
        robotsExplanation = `robots.txt returned HTTP ${result.status}, so its rules could not be read.`;
      } else if (/^\s*<(!doctype|html)/i.test(result.body)) {
        // A site with no robots.txt that answers with its 404 page instead of a 404
        // status. Treating that HTML as robots.txt would parse nonsense.
        robotsText = '';
        robotsStatus = 'warn';
        robotsExplanation =
          'This domain answered the robots.txt request with an HTML page rather than a robots file, ' +
          'which means there is effectively no robots.txt. Nothing is blocked, but nothing is stated ' +
          'either — add a real robots.txt.';
      } else {
        robotsText = result.body;
        robotsStatus = 'pass';
        robotsExplanation = `robots.txt was read from ${robotsUrl}.`;
      }
    }
  }

  const groups = robotsText === undefined ? [] : parseRobots(robotsText);

  const verdicts: CrawlerVerdict[] = crawlers.map((crawler) => {
    if (robotsText === undefined) {
      return {
        crawler,
        status: 'unknown' as const,
        explanation: `robots.txt could not be read, so ${crawler}'s access is unknown.`,
      };
    }
    const verdict = robotsVerdict(groups, crawler, path);
    const named = groups.some((group) => group.agents.includes(crawler.toLowerCase()));
    return {
      crawler,
      status: verdict.allowed ? ('pass' as const) : ('fail' as const),
      matchedGroup: verdict.group,
      matchedRule: verdict.rule,
      explanation: verdict.allowed
        ? named
          ? `${crawler} is named in robots.txt and is allowed to fetch ${path}.`
          : `${crawler} is not blocked. ${
              groups.length
                ? `No rule matches it, so it falls under the general rules, which permit ${path}.`
                : 'robots.txt contains no rules at all.'
            }`
        : `${crawler} is BLOCKED from ${path} by "${verdict.rule}" in the ${
            verdict.group === '*' ? 'catch-all (User-agent: *)' : `User-agent: ${verdict.group}`
          } section. Remove that rule, or add an explicit "User-agent: ${crawler}" section with ` +
          '"Allow: /", or this crawler will never see your products.',
    };
  });

  /* server-rendered content */
  let rendering: RenderVerdict;
  if (options.page) {
    rendering = assessRendering(options.page);
  } else if (!origin) {
    rendering = {
      status: 'unknown',
      explanation:
        'No storefront origin is configured, so no page could be fetched. Set STOREFRONT_URL.',
    };
  } else {
    const target = `${origin}${path}`;
    const result = await fetchText(target, timeout);
    rendering =
      'error' in result
        ? { status: 'unknown', url: target, explanation: `The page could not be fetched: ${result.error}` }
        : assessRendering({
            url: target,
            html: result.body,
            xRobotsTag: result.headers.get('x-robots-tag') ?? undefined,
          });
  }

  // The robots.txt finding counts too. A domain with no robots.txt blocks nothing, so
  // every crawler passes — but "nothing is stated" is a real advisory, and leaving it
  // out of the tally reported the whole check as clean when it was not.
  const all: CheckStatus[] = [robotsStatus, ...verdicts.map((v) => v.status), rendering.status];
  const summary = {
    pass: all.filter((s) => s === 'pass').length,
    fail: all.filter((s) => s === 'fail').length,
    warn: all.filter((s) => s === 'warn').length,
    unknown: all.filter((s) => s === 'unknown').length,
  };

  return {
    checkedAt,
    robots: {
      url: robotsUrl,
      status: robotsStatus,
      explanation: robotsExplanation,
      httpStatus: robotsHttpStatus,
    },
    crawlers: verdicts,
    serverRendering: rendering,
    summary,
    overall: summary.fail > 0 ? 'fail' : summary.unknown > 0 ? 'unknown' : summary.warn > 0 ? 'warn' : 'pass',
  };
}
