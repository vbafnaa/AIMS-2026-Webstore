import test from 'node:test';
import assert from 'node:assert/strict';
import { EARLY_BIRD_END_EPOCH, isEarlyBird, priceAt } from '../src/lib/pricing.ts';
import { catalog } from '../src/data/catalog.ts';

const cap = catalog.find(product => product.id === 'cap');
const crewneck = catalog.find(product => product.id === 'crewneck');

test('early bird prices include all of October 29, 2026 in Seattle', () => {
  assert.equal(EARLY_BIRD_END_EPOCH, Date.parse('2026-10-30T00:00:00-07:00') / 1000);
  assert.equal(priceAt(cap, EARLY_BIRD_END_EPOCH - 1), 1499);
  assert.equal(isEarlyBird(cap, EARLY_BIRD_END_EPOCH - 1), true);
  assert.equal(priceAt(cap, EARLY_BIRD_END_EPOCH), 1999);
  assert.equal(isEarlyBird(cap, EARLY_BIRD_END_EPOCH), false);
  assert.equal(priceAt(cap, EARLY_BIRD_END_EPOCH + 1), 1999);
  assert.equal(priceAt(crewneck, EARLY_BIRD_END_EPOCH - 1), 2999);
  assert.equal(priceAt(crewneck, EARLY_BIRD_END_EPOCH), 3499);
});

test('invalid clock and incomplete promotion metadata never enable the discount', () => {
  for (const epoch of [NaN, Infinity, -Infinity]) assert.equal(priceAt(cap, epoch), 1999);
  assert.equal(priceAt({ ...cap, early_bird_ends_at_epoch: null }, 1), 1999);
  assert.equal(priceAt({ ...cap, early_bird_price_cents: null }, 1), 1999);
  assert.equal(priceAt({ ...cap, early_bird_price_cents: -1 }, 1), 1999);
  assert.equal(priceAt({ ...cap, early_bird_price_cents: 2999 }, 1), 1999);
});

test('crewneck and sticker prices are configured correctly', () => {
  assert.equal(crewneck.price_cents, 3499);
  assert.equal(crewneck.early_bird_price_cents, 2999);
  for (const product of catalog.filter(product => product.id !== 'cap' && product.id !== 'crewneck')) {
    assert.equal(priceAt(product, EARLY_BIRD_END_EPOCH - 1), product.price_cents);
    assert.equal(priceAt(product, EARLY_BIRD_END_EPOCH), product.price_cents);
  }
});

test('every product has structured information for its details panel', () => {
  for (const product of catalog) {
    assert.ok(product.specifications.length > 0, `${product.name} should have product specifications`);
    assert.ok(product.specifications.every(specification => specification.trim().length > 0));
  }
});
