import test from 'node:test';
import assert from 'node:assert/strict';
import { itemsOf, productOf, searchBody, withProducts, region } from './amazon-products.mjs';

const item = {
  asin: 'B0TEST1234',
  detailPageURL: 'https://www.amazon.in/dp/B0TEST1234?tag=aaoolo-21',
  itemInfo: { title: { displayValue: 'Trail Runner Trekking Shoes for Men, Waterproof, Lightweight Hiking Boots with Grip' } },
  images: { primary: { large: { url: 'https://m.media-amazon.com/images/I/abc._SL500_.jpg' } } },
};

test('India uses the EU token endpoint', () => {
  assert.equal(region['www.amazon.in'].token, 'https://api.amazon.co.uk/auth/o2/token');
});

test('search asks for pictures and titles in lowerCamelCase, with the tag', () => {
  const b = searchBody('trekking shoes', 'aaoolo-21', 'www.amazon.in');
  assert.equal(b.partnerTag, 'aaoolo-21');
  assert.equal(b.marketplace, 'www.amazon.in');
  assert.ok(b.resources.includes('images.primary.large'));
});

test('items come out of either wrapper', () => {
  assert.equal(itemsOf({ searchResult: { items: [item] } }).length, 1);
  assert.equal(itemsOf({ SearchResult: { Items: [item] } }).length, 1);
  assert.deepEqual(itemsOf({}), []);
});

test('a product keeps Amazon\'s picture link, a short title and the category words, never a price', () => {
  const p = productOf(item, 'trekking', 'trekking shoes', ['trek', 'hiking']);
  assert.equal(p.asin, 'B0TEST1234');
  assert.ok(p.title.length <= 60);
  assert.match(p.image, /^https:\/\/m\.media-amazon\.com\//);
  assert.ok(p.keywords.includes('trekking') && p.keywords.includes('hiking'));
  assert.equal(p.price, undefined);
  assert.equal(productOf({ ...item, images: { primary: { large: { url: 'https://example.com/x.jpg' } } } }, 'c', 'p', []), null, 'only Amazon\'s own image host');
  assert.equal(productOf({ ...item, asin: 'bad' }, 'c', 'p', []), null);
});

test('products are stamped with when they were fetched, one per ASIN', () => {
  const p = productOf(item, 'trekking', 'trekking shoes', []);
  const o = withProducts({ amazon: { tag: 'x' } }, [p, p, null], new Date('2026-11-06T10:00:00Z'));
  assert.equal(o.products.length, 1);
  assert.equal(o.productsFetchedAt, '2026-11-06T10:00:00.000Z');
  assert.equal(o.amazon.tag, 'x');
});
