import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let handler;
let jobs;
let calls;
let rpcResults;
let webhookStatus;
const variables = new Map();
globalThis.Deno = { env: { get: key => variables.get(key) }, serve: fn => { handler = fn; } };
globalThis.EdgeRuntime = { waitUntil: promise => { jobs.push(promise); } };
await import('../supabase/functions/checkout/index.ts');

beforeEach(() => {
  jobs = []; calls = []; rpcResults = {}; webhookStatus = 200;
  variables.clear();
  Object.entries({ SUPABASE_URL: 'https://database.example', SUPABASE_SERVICE_ROLE_KEY: 'server-only', ALLOWED_ORIGIN: 'https://shop.example', ALLOW_EMAIL_QUEUE_ONLY: 'true', EMAIL_DISPATCH_SECRET: 'scheduler-secret' }).forEach(([k,v]) => variables.set(k,v));
  globalThis.fetch = async (url, options) => {
    const name = String(url).split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ name, body, headers: options.headers });
    if (String(url).includes('mail.example')) return new Response('', { status: webhookStatus });
    if (rpcResults[name] instanceof Error) throw rpcResults[name];
    if (rpcResults[name]?.message) return Response.json(rpcResults[name], { status: 400 });
    return Response.json(rpcResults[name] ?? ({ take_checkout_slot: true, place_order: { id: 'order-1', total_cents: 1999, status: 'placed' }, claim_emails: [], finish_email: null })[name]);
  };
});

const order = () => ({ key: crypto.randomUUID(), email: ' STUDENT@example.com ', lines: [{ kind: 'single', product_id: 'cap', quantity: 1, size: '' }], expected_total_cents: 1999 });
const request = (body = order(), headers = {}) => new Request('https://database.example/functions/v1/checkout', { method: 'POST', headers: { origin: 'https://shop.example', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('checkout normalizes email and delegates all pricing and inventory to one database operation', async () => {
  const body = order();
  const response = await handler(request(body));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email_status, 'queued');
  const placed = calls.find(c => c.name === 'place_order');
  assert.deepEqual(placed.body, { p_key: body.key, p_email: 'student@example.com', p_lines: body.lines, p_expected_total: 1999 });
  assert.equal(placed.headers.Authorization, 'Bearer server-only');
  assert.equal(calls[0].body.p_bucket.length, 64);
  await Promise.all(jobs);
});

test('rejects invalid emails, keys, totals, and empty selections before database writes', async () => {
  for (const changes of [{ email: 'bad' }, { key: 'bad' }, { expected_total_cents: -1 }, { expected_total_cents: 1.5 }, { lines: [] }]) {
    assert.equal((await handler(request({ ...order(), ...changes }))).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('rejects malformed JSON and oversized streamed requests', async () => {
  assert.equal((await handler(new Request('https://example.com', { method: 'POST', headers: { origin: 'https://shop.example', 'content-type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await handler(request({ ...order(), padding: 'a'.repeat(17000) }))).status, 413);
  assert.equal(calls.length, 0);
});

test('preflight permits only the configured origin', async () => {
  const allowed = await handler(new Request('https://example.com', { method: 'OPTIONS', headers: { origin: 'https://shop.example' } }));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://shop.example');
  const denied = await handler(request(order(), { origin: 'https://unrelated.example' }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('database stock conflicts are actionable and do not schedule email', async () => {
  rpcResults.place_order = { message: 'OUT_OF_STOCK' };
  const response = await handler(request());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'OUT_OF_STOCK');
  assert.equal(jobs.length, 0);
});

test('changed prices require customer review', async () => {
  rpcResults.place_order = { message: 'PRICE_CHANGED' };
  const response = await handler(request());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'PRICE_CHANGED');
});

test('reused keys and invalid database inputs get definitive rejections', async () => {
  for (const [message, status] of [['KEY_REUSED',409], ['INVALID_SIZE',400], ['INVALID_BUNDLE',400]]) {
    rpcResults.place_order = { message };
    assert.equal((await handler(request())).status, status);
  }
});

test('network failures preserve the uncertainty needed for safe retries', async () => {
  rpcResults.place_order = new Error('network disconnected');
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /same order/);
});

test('rate limit stops requests before order creation', async () => {
  rpcResults.take_checkout_slot = false;
  assert.equal((await handler(request())).status, 429);
  assert.equal(calls.some(c => c.name === 'place_order'), false);
});

test('production checkout refuses to open without an email adapter', async () => {
  variables.set('ALLOW_EMAIL_QUEUE_ONLY', 'false');
  assert.equal((await handler(request())).status, 503);
  assert.equal(calls.length, 0);
});

test('email failures keep successful orders and record a retryable failure', async () => {
  variables.set('EMAIL_WEBHOOK_URL', 'https://mail.example/send');
  variables.set('EMAIL_WEBHOOK_TOKEN', 'mail-secret');
  rpcResults.claim_emails = [{ order_id: 'order-1', lease_token: 'lease-1', email: 'student@example.com', status: 'placed' }];
  webhookStatus = 503;
  assert.equal((await handler(request())).status, 200);
  await Promise.all(jobs);
  assert.equal(calls.find(c => c.name === 'finish_email').body.p_success, false);
  const delivery = calls.find(c => c.name === 'send');
  assert.equal(delivery.headers['Idempotency-Key'], 'order-order-1');
  assert.equal('lease_token' in delivery.body, false);
});

test('scheduler requires a secret and can dispatch without a browser origin', async () => {
  const bad = new Request('https://example.com', { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' });
  assert.equal((await handler(bad)).status, 403);
  const good = new Request('https://example.com', { method: 'POST', headers: { authorization: 'Bearer scheduler-secret' }, body: '{}' });
  assert.equal((await handler(good)).status, 200);
});
