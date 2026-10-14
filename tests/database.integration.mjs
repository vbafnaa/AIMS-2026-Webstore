import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_SUPABASE_URL;
const secret = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const publicKey = process.env.TEST_SUPABASE_PUBLISHABLE_KEY;
const enabled = Boolean(url && secret && publicKey && process.env.AIMS_DISPOSABLE_TEST_PROJECT === 'yes');

test('real Postgres transaction, concurrency, and access-control checks', { skip: !enabled && 'Requires a seeded disposable Supabase project; see README.' }, async t => {
  const prefix = `test-${crypto.randomUUID().slice(0,8)}`;
  const cap = `${prefix}-cap`, sticker = `${prefix}-sticker`, preorder = `${prefix}-preorder`;
  const keys = [];
  const request = async (path, method = 'GET', body, key = secret) => {
    const res = await fetch(`${url}/rest/v1/${path}`, { method, headers: { apikey: key, ...(key === secret ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  const rpc = (name, body, key) => request(`rpc/${name}`, 'POST', body, key);
  const makeKey = () => { const key = crypto.randomUUID(); keys.push(key); return key; };
  const place = (lines, total, key = makeKey()) => rpc('place_order', {
    p_key: key,
    p_email: `${prefix}@example.com`,
    p_lines: lines,
    p_expected_total: total,
    p_full_name: 'Test Student',
    p_phone_number: '+1 206 555 0100',
    p_zelle_payer_name: 'Test Payer',
    p_payment_reference: '',
    p_pickup_option: 'mgh_440',
    p_payment_proof_path: `${key}.png`,
  });
  const single = (id, quantity = 1, size = '') => ({ kind: 'single', product_id: id, quantity, size });
  const pack = (size, quantity = size) => ({ kind: 'bundle', size, items: [{ product_id: sticker, quantity }] });
  const stock = async id => (await request(`products?id=eq.${id}&select=stock`)).data[0].stock;
  const setStock = (id, stock) => request(`products?id=eq.${id}`, 'PATCH', { stock });
  const settings = await request('shop_settings?id=eq.true');
  assert.equal(settings.status, 200);
  const originalSettings = settings.data[0];
  try {
    assert.ok((await request('products', 'POST', [
      { id: cap, name: 'Test cap', category: 'wear', price_cents: 1999, stock: 1, preorder: false },
      { id: sticker, name: 'Test sticker', category: 'stickers', price_cents: 299, stock: 20, preorder: false },
      { id: preorder, name: 'Test preorder', category: 'wear', price_cents: 2999, stock: null, preorder: true, sizes: ['XS','S','M','L','XL','XXL'] },
    ])).status < 300);
    assert.ok((await request('shop_settings', 'POST', { id: true, pickup_address: 'Test pickup only', orders_open: true, bundle_three_cents: 599, bundle_five_cents: 999 })).status < 300);

    await t.test('two concurrent buyers of the last unit: only one succeeds', async () => {
      const results = await Promise.all([place([single(cap)], 1999), place([single(cap)], 1999)]);
      assert.equal(results.filter(r => r.status === 200).length, 1);
      assert.match(results.find(r => r.status !== 200).data.message, /OUT_OF_STOCK/);
      assert.equal(await stock(cap), 0);
    });
    await t.test('multi-item stock failure rolls back the entire order', async () => {
      const before = await stock(sticker);
      const result = await place([single(sticker), single(cap)], 2298);
      assert.match(result.data.message, /OUT_OF_STOCK/);
      assert.equal(await stock(sticker), before);
    });
    await t.test('concurrent identical keys create one order and deduct once', async () => {
      await setStock(cap, 5);
      const key = makeKey();
      const results = await Promise.all([place([single(cap)], 1999, key), place([single(cap)], 1999, key)]);
      results.forEach(r => assert.equal(r.status, 200));
      assert.equal(results[0].data.id, results[1].data.id);
      assert.equal(await stock(cap), 4);
      const saved = (await request(`orders?id=eq.${results[0].data.id}&select=full_name,phone_number,zelle_payer_name,payment_reference,pickup_option,payment_proof_path`)).data[0];
      assert.deepEqual(saved, {
        full_name: 'Test Student',
        phone_number: '+1 206 555 0100',
        zelle_payer_name: 'Test Payer',
        payment_reference: '',
        pickup_option: 'mgh_440',
        payment_proof_path: `${key}.png`,
      });
      assert.match((await place([single(cap, 2)], 3998, key)).data.message, /KEY_REUSED/);
    });
    await t.test('server price comparison prevents stale or altered totals', async () => {
      assert.match((await place([single(cap)], 1)).data.message, /PRICE_CHANGED/);
      assert.equal(await stock(cap), 4);
    });
    await t.test('server epoch expires promotional prices while preserving already committed retry totals', async () => {
      const now = Math.floor(Date.now() / 1000);
      await request(`products?id=eq.${cap}`, 'PATCH', { early_bird_price_cents: 1499, early_bird_ends_at_epoch: now + 3600 });
      const key = makeKey();
      const discounted = await place([single(cap)], 1499, key);
      assert.equal(discounted.status, 200);
      assert.equal(discounted.data.total_cents, 1499);
      await request(`products?id=eq.${cap}`, 'PATCH', { early_bird_ends_at_epoch: now - 3600 });
      const before = await stock(cap);
      assert.match((await place([single(cap)], 1499)).data.message, /PRICE_CHANGED/);
      assert.equal(await stock(cap), before);
      const retry = await place([single(cap)], 1499, key);
      assert.equal(retry.data.id, discounted.data.id);
      assert.equal(retry.data.total_cents, 1499);
      assert.equal(await stock(cap), before);
      const regular = await place([single(cap)], 1999);
      assert.equal(regular.status, 200);
      assert.equal(regular.data.total_cents, 1999);
    });
    await t.test('bundles and singles share the same inventory', async () => {
      await setStock(sticker, 5);
      assert.match((await place([pack(3), pack(3)], 1198)).data.message, /OUT_OF_STOCK/);
      assert.equal(await stock(sticker), 5);
      const result = await place([pack(3), single(sticker, 2)], 1197);
      assert.equal(result.status, 200);
      assert.equal(await stock(sticker), 0);
      await rpc('cancel_order', { p_order_id: result.data.id });
      await rpc('cancel_order', { p_order_id: result.data.id });
      assert.equal(await stock(sticker), 5);
    });
    await t.test('bad packs, quantities and sizes are rejected', async () => {
      for (const [lines, price, error] of [
        [[pack(3,2)], 599, /INVALID_BUNDLE/],
        [[single(cap,0)], 1999, /INVALID_QUANTITY/],
        [[single(cap,-1)], 1999, /INVALID_QUANTITY/],
        [[single(cap,1.5)], 1999, /INVALID_QUANTITY/],
        [[single(preorder,1,'XXXL')], 2999, /INVALID_SIZE/],
        [[single(preorder)], 2999, /INVALID_SIZE/],
      ]) assert.match((await place(lines, price)).data.message, error);
    });
    await t.test('preorders track size without finite stock; cancellation leaves stock null', async () => {
      const result = await place([single(preorder, 2, 'XS'), single(preorder, 1, 'XXL')], 8997);
      assert.equal(result.status, 200);
      assert.equal(await stock(preorder), null);
      assert.equal((await request(`order_items?order_id=eq.${result.data.id}`)).data.length, 2);
      await rpc('cancel_order', { p_order_id: result.data.id });
      assert.equal(await stock(preorder), null);
    });
    await t.test('collected orders cannot be cancelled and restocked', async () => {
      const result = await place([single(cap)], 1999);
      await request(`orders?id=eq.${result.data.id}`, 'PATCH', { status: 'collected' });
      assert.match((await rpc('cancel_order', { p_order_id: result.data.id })).data.message, /ORDER_ALREADY_COLLECTED/);
    });
    await t.test('public access reads catalog but cannot read orders, mutate stock, or call privileged functions', async () => {
      assert.equal((await request('products?select=id', 'GET', undefined, publicKey)).status, 200);
      assert.ok((await request('orders?select=*', 'GET', undefined, publicKey)).status >= 400);
      assert.ok((await request(`products?id=eq.${cap}`, 'PATCH', { stock: 100 }, publicKey)).status >= 400);
      assert.ok((await rpc('place_order', { p_key: makeKey(), p_email: 'public@example.com', p_lines: [single(cap)], p_expected_total: 1999 }, publicKey)).status >= 400);
    });
    await t.test('rate limit updates atomically across simultaneous requests', async () => {
      const responses = await Promise.all(Array.from({ length: 11 }, () => rpc('take_checkout_slot', { p_bucket: prefix })));
      assert.equal(responses.filter(r => r.data === true).length, 10);
    });
    await t.test('outbox leases prevent two workers claiming the same email', async () => {
      const results = await Promise.all([rpc('claim_emails', {}), rpc('claim_emails', {})]);
      const ids = results.flatMap(r => r.data.map(m => m.order_id));
      assert.equal(ids.length, new Set(ids).size);
      const message = results.flatMap(r => r.data)[0];
      assert.ok(message);
      await rpc('finish_email', { p_order_id: message.order_id, p_token: message.lease_token, p_success: false, p_error: 'Test retry' });
      const row = (await request(`email_outbox?order_id=eq.${message.order_id}`)).data[0];
      assert.equal(row.sent_at, null);
      assert.equal(row.lease_token, null);
      assert.equal(row.last_error, 'Test retry');
    });
  } finally {
    const orders = await request(`orders?email=eq.${prefix}@example.com&select=id`);
    if (orders.data?.length) {
      const ids = orders.data.map(o => o.id).join(',');
      for (const table of ['email_outbox','order_items']) await request(`${table}?order_id=in.(${ids})`, 'DELETE');
      await request(`orders?id=in.(${ids})`, 'DELETE');
    }
    await request(`products?id=in.(${cap},${sticker},${preorder})`, 'DELETE');
    await request(`checkout_limits?bucket=eq.${prefix}`, 'DELETE');
    if (originalSettings) await request('shop_settings', 'POST', originalSettings);
    else await request('shop_settings?id=eq.true', 'DELETE');
  }
});
