#!/usr/bin/env node
// Real Amazon products for Myind's ads, refreshed daily (owner, 2026-11-06:
// "use the proper image for ads, Amazon"). For each category in config.json,
// asks Amazon's Creators API (PA-API 5 was retired in 2026 and now answers
// 403) for a few products of each of its "picks", and writes them to
// offers.products with offers.productsFetchedAt.
//
// Amazon's rules, kept here and in the app (lib/offers/offer_config.dart):
//   - its product images are never stored: only their links, for at most 24 h.
//     The app loads them into memory at start and drops products whose data
//     is older than 24 h, so this must run at least daily.
//   - no prices are written: a price shown must be current, and this runs once a day.
//
// Credentials (Associates Central → Creators API) come only from the
// environment, never from a file in this repo:
//   AMAZON_CREATORS_ID, AMAZON_CREATORS_SECRET, AMAZON_CREATORS_VERSION (EU, which covers India: 3.2)
// Usage:
//   node scripts/amazon-products.mjs --dry-run   # prints what it would ask; no network
//   node scripts/amazon-products.mjs             # updates config.json (does not commit or push)
//
// Unverified against a live account (no credentials when written): the
// version header name and the exact search response wrapper. Both are read
// defensively; run once by hand and check the printed summary.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const configPath = join(here, '..', 'config.json');

/** India's marketplace sits in Amazon's EU region for the Creators API. */
export const region = {
  'www.amazon.in': { token: 'https://api.amazon.co.uk/auth/o2/token', version: '3.2' },
  'www.amazon.co.uk': { token: 'https://api.amazon.co.uk/auth/o2/token', version: '3.2' },
  'www.amazon.com': { token: 'https://api.amazon.com/auth/o2/token', version: '3.1' },
};
export const api = 'https://creatorsapi.amazon/catalog/v1/searchItems';
const perPick = 1; // products per Amazon search
const maxProducts = 24; // the phone keeps 30 pictures: sponsors and categories need the rest

/** The search request body for one pick. */
export function searchBody(pick, tag, marketplace) {
  return {
    keywords: pick,
    partnerTag: tag,
    partnerType: 'Associates',
    marketplace,
    itemCount: 3,
    resources: ['images.primary.large', 'images.primary.medium', 'itemInfo.title'],
  };
}

/** Items from a search answer, whatever wrapper it comes in. */
export function itemsOf(answer) {
  const r = answer?.searchResult ?? answer?.SearchResult ?? answer;
  const items = r?.items ?? r?.Items ?? [];
  return Array.isArray(items) ? items : [];
}

/** One config product from an item, or null when it lacks an ASIN, title or picture. */
export function productOf(item, category, pick, words) {
  const asin = item?.asin;
  const title = item?.itemInfo?.title?.displayValue;
  const img = item?.images?.primary?.large?.url ?? item?.images?.primary?.medium?.url;
  if (!/^[A-Z0-9]{10}$/.test(asin ?? '') || !title || !/^https:\/\/[^/]*media-amazon\.com\//.test(img ?? '')) return null;
  return {
    id: `amz-${asin.toLowerCase()}`,
    asin,
    title: title.length > 60 ? `${title.slice(0, 57).trimEnd()}…` : title,
    body: `On Amazon · ${pick}`,
    image: img,
    keywords: [...new Set([...pick.toLowerCase().split(/\s+/).filter((w) => w.length > 2), ...words])].slice(0, 12),
    category,
  };
}

/** The new offers block: products from [found], stamped now. Prices are never written. */
export function withProducts(offers, found, now = new Date()) {
  const seen = new Set();
  const products = [];
  for (const p of found) {
    if (!p || seen.has(p.asin)) continue;
    seen.add(p.asin);
    products.push(p);
    if (products.length >= maxProducts) break;
  }
  return { ...offers, products, productsFetchedAt: now.toISOString() };
}

async function token(marketplace, id, secret) {
  const r = await fetch(region[marketplace].token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'creatorsapi::default' }),
  });
  if (!r.ok) throw new Error(`Amazon refused the Creators API credentials (${r.status})`);
  return (await r.json()).access_token;
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const o = config.offers ?? {};
  const tag = o.amazon?.tag;
  const marketplace = o.amazon?.domain ?? 'www.amazon.in';
  if (!tag || !region[marketplace]) throw new Error('config.json needs offers.amazon.tag and a known offers.amazon.domain');
  const jobs = [];
  for (const [category, v] of Object.entries(o.categories ?? {})) {
    const words = (Array.isArray(v) ? v : v?.words ?? []).map((w) => `${w}`.toLowerCase());
    for (const pick of v?.picks ?? []) jobs.push({ category, pick, words });
  }
  if (dry) {
    for (const j of jobs) console.log(`would search ${marketplace} for "${j.pick}" (${j.category})`);
    console.log(`${jobs.length} searches; no network used`);
    return;
  }
  const id = process.env.AMAZON_CREATORS_ID, secret = process.env.AMAZON_CREATORS_SECRET;
  if (!id || !secret) throw new Error('Set AMAZON_CREATORS_ID and AMAZON_CREATORS_SECRET (Associates Central → Creators API)');
  const version = process.env.AMAZON_CREATORS_VERSION ?? region[marketplace].version;
  const bearer = await token(marketplace, id, secret);
  const found = [];
  for (const j of jobs) {
    const r = await fetch(api, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'x-marketplace': marketplace, 'x-amz-version': version },
      body: JSON.stringify(searchBody(j.pick, tag, marketplace)),
    });
    if (!r.ok) {
      console.error(`"${j.pick}": Amazon answered ${r.status}`);
      continue;
    }
    const items = itemsOf(await r.json()).map((it) => productOf(it, j.category, j.pick, j.words)).filter(Boolean).slice(0, perPick);
    found.push(...items);
    await new Promise((ok) => setTimeout(ok, 1100)); // about one request a second
  }
  if (!found.length) throw new Error('No products came back; config.json is unchanged');
  config.offers = withProducts(o, found);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`${config.offers.products.length} products written, fetched ${config.offers.productsFetchedAt}. Not committed.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
