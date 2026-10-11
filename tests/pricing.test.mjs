import test from 'node:test';
import assert from 'node:assert/strict';
import { CAP_EARLY_BIRD_END_EPOCH, isEarlyBird, priceAt } from '../src/lib/pricing.ts';
import { catalog } from '../src/data/catalog.ts';

const cap = catalog.find(product => product.id === 'cap');

test('cap discount includes all of October 29, 2026 in Seattle', () => {
  assert.equal(CAP_EARLY_BIRD_END_EPOCH, Date.parse('2026-10-30T00:00:00-07:00') / 1000);
  assert.equal(priceAt(cap, CAP_EARLY_BIRD_END_EPOCH - 1), 1499);
  assert.equal(isEarlyBird(cap, CAP_EARLY_BIRD_END_EPOCH - 1), true);
  assert.equal(priceAt(cap, CAP_EARLY_BIRD_END_EPOCH), 1999);
  assert.equal(isEarlyBird(cap, CAP_EARLY_BIRD_END_EPOCH), false);
  assert.equal(priceAt(cap, CAP_EARLY_BIRD_END_EPOCH + 1), 1999);
});

test('invalid clock and incomplete promotion metadata never enable the discount', () => {
  for (const epoch of [NaN, Infinity, -Infinity]) assert.equal(priceAt(cap, epoch), 1999);
  assert.equal(priceAt({ ...cap, early_bird_ends_at_epoch: null }, 1), 1999);
  assert.equal(priceAt({ ...cap, early_bird_price_cents: null }, 1), 1999);
  assert.equal(priceAt({ ...cap, early_bird_price_cents: -1 }, 1), 1999);
  assert.equal(priceAt({ ...cap, early_bird_price_cents: 2999 }, 1), 1999);
});

test('the cap promotion does not change sweatshirt or sticker pricing', () => {
  for (const product of catalog.filter(product => product.id !== 'cap')) {
    assert.equal(priceAt(product, CAP_EARLY_BIRD_END_EPOCH - 1), product.price_cents);
    assert.equal(priceAt(product, CAP_EARLY_BIRD_END_EPOCH), product.price_cents);
  }
});
