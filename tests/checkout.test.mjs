import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let handler;
let jobs;
let calls;
let rpcResults;
let webhookStatus;
let proofObjects;
const variables = new Map();
globalThis.Deno = { env: { get: key => variables.get(key) }, serve: fn => { handler = fn; } };
globalThis.EdgeRuntime = { waitUntil: promise => { jobs.push(promise); } };
await import('../supabase/functions/checkout/index.ts');

beforeEach(() => {
  jobs = []; calls = []; rpcResults = {}; webhookStatus = 200; proofObjects = new Map();
  variables.clear();
  Object.entries({ SUPABASE_URL: 'https://database.example', SUPABASE_SERVICE_ROLE_KEY: 'server-only', ALLOWED_ORIGIN: 'https://shop.example', ALLOW_EMAIL_QUEUE_ONLY: 'true', EMAIL_DISPATCH_SECRET: 'scheduler-secret' }).forEach(([k,v]) => variables.set(k,v));
  globalThis.fetch = async (url, options) => {
    const name = String(url).split('/').at(-1);
    if (String(url).includes('/storage/v1/object/')) {
      const path = new URL(url).pathname.split('/').at(-1);
      const method = options.method ?? 'GET';
      calls.push({ name: method === 'GET' ? 'payment-proof-read' : method === 'DELETE' ? 'payment-proof-delete' : 'payment-proof-upload', body: options.body, headers: options.headers });
      if (method === 'DELETE') {
        proofObjects.delete(path);
        return new Response(null, { status: 204 });
      }
      if (method === 'GET') {
        const stored = proofObjects.get(path);
        return stored ? new Response(stored, { headers: { 'Content-Type': 'image/png' } }) : new Response('', { status: 404 });
      }
      if (proofObjects.has(path)) return new Response('duplicate', { status: 409 });
      proofObjects.set(path, new Uint8Array(options.body));
      return Response.json({ Key: `payment-proofs/${path}` });
    }
    const body = JSON.parse(options.body);
    calls.push({ name, body, headers: options.headers });
    if (String(url).includes('mail.example')) return new Response('', { status: webhookStatus });
    if (rpcResults[name] instanceof Error) throw rpcResults[name];
    if (rpcResults[name]?.message) return Response.json(rpcResults[name], { status: 400 });
    return Response.json(rpcResults[name] ?? ({ take_checkout_slot: true, place_order: { id: 'order-1', total_cents: 1999, status: 'placed' }, claim_emails: [], finish_email: null })[name]);
  };
});

const order = () => ({
  key: crypto.randomUUID(),
  email: ' STUDENT@example.com ',
  lines: [{ kind: 'single', product_id: 'cap', quantity: 1, size: '' }],
  expected_total_cents: 1999,
  customer: { full_name: 'Student Name', phone_number: '+1 206 555 0100', zelle_payer_name: 'Student Payer', payment_reference: '', pickup_option: 'mgh_440' },
  payment_proof: { file_name: 'payment.png', content_type: 'image/png', data: 'iVBORw0KGgo=' },
});
const request = (body = order(), headers = {}) => {
  const { payment_proof: proof, ...checkoutBody } = body;
  if (proof?.content_type && body.key) checkoutBody.payment_proof_path = `${body.key}.${proof.content_type === 'image/jpeg' ? 'jpg' : proof.content_type.slice(6)}`;
  return new Request('https://database.example/functions/v1/checkout', { method: 'POST', headers: { origin: 'https://shop.example', 'content-type': 'application/json', ...headers }, body: JSON.stringify(checkoutBody) });
};
const uploadProof = (body, headers = {}) => new Request('https://database.example/functions/v1/checkout', {
  method: 'POST',
  headers: {
    origin: 'https://shop.example',
    'content-type': body.payment_proof.content_type,
    'x-payment-proof-key': body.key,
    'x-payment-proof-email': body.email.trim().toLowerCase(),
    ...headers,
  },
  body: Uint8Array.from(atob(body.payment_proof.data), char => char.charCodeAt(0)),
});
async function submit(body = order(), headers = {}) {
  if (body.payment_proof) {
    const uploadResponse = await handler(uploadProof(body, headers));
    if (!uploadResponse.ok) return uploadResponse;
  }
  return handler(request(body, headers));
}

test('checkout stores a private proof and delegates customer, pickup, pricing, and inventory to one database operation', async () => {
  const body = order();
  const response = await submit(body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email_status, 'queued');
  const uploaded = calls.find(c => c.name === 'payment-proof-upload');
  assert.ok(uploaded);
  assert.equal(uploaded.headers['Content-Type'], 'image/png');
  const placed = calls.find(c => c.name === 'place_order');
  assert.deepEqual(placed.body, {
    p_key: body.key,
    p_email: 'student@example.com',
    p_lines: body.lines,
    p_expected_total: 1999,
    p_full_name: 'Student Name',
    p_phone_number: '+1 206 555 0100',
    p_zelle_payer_name: 'Student Payer',
    p_payment_reference: '',
    p_pickup_option: 'mgh_440',
    p_payment_proof_path: `${body.key}.png`,
  });
  assert.equal(placed.headers.Authorization, 'Bearer server-only');
  const rateLimitCalls = calls.filter(c => c.name === 'take_checkout_slot');
  assert.equal(rateLimitCalls.length, 2);
  assert.equal(rateLimitCalls[0].body.p_bucket.length, 70);
  assert.equal(rateLimitCalls[1].body.p_bucket.length, 64);
  await Promise.all(jobs);
});

test('rejects incomplete customer details and invalid orders before database writes', async () => {
  for (const changes of [
    { email: 'bad' },
    { key: 'bad' },
    { expected_total_cents: -1 },
    { expected_total_cents: 1.5 },
    { lines: [] },
    { customer: { ...order().customer, full_name: ' ' } },
    { customer: { ...order().customer, phone_number: '123' } },
    { customer: { ...order().customer, zelle_payer_name: '' } },
    { customer: { ...order().customer, pickup_option: 'somewhere-else' } },
    { payment_proof: null },
    { payment_proof: { content_type: 'image/svg+xml', data: 'PHN2Zz4=' } },
    { payment_proof: { content_type: 'image/png', data: 'bm90IGFuIGltYWdl' } },
  ]) {
    assert.equal((await handler(request({ ...order(), ...changes }))).status, 400);
  }
  assert.equal(calls.some(c => c.name === 'place_order'), false);
});

test('a retry retains the original proof and a reused key cannot replace it', async () => {
  const body = order();
  assert.equal((await submit(body)).status, 200);
  const original = proofObjects.get(`${body.key}.png`);
  const changed = { ...body, payment_proof: { ...body.payment_proof, data: 'iVBORw0KGgoAAA==' } };
  const response = await handler(uploadProof(changed));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'KEY_REUSED');
  assert.deepEqual(proofObjects.get(`${body.key}.png`), original);
});

test('rejects malformed JSON and oversized streamed requests', async () => {
  assert.equal((await handler(new Request('https://example.com', { method: 'POST', headers: { origin: 'https://shop.example', 'content-type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await handler(request({ ...order(), padding: 'a'.repeat(33000) }))).status, 413);
  assert.equal(calls.length, 0);
});

test('uploads valid screenshots as raw binary and rejects invalid or oversized proofs', async () => {
  const body = order();
  const response = await handler(uploadProof(body));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { payment_proof_path: `${body.key}.png` });
  const invalid = { ...body, key: crypto.randomUUID(), payment_proof: { ...body.payment_proof, data: 'bm90IGFuIGltYWdl' } };
  assert.equal((await handler(uploadProof(invalid)).then(r => r.status)), 400);
  const large = { ...body, key: crypto.randomUUID(), payment_proof: { ...body.payment_proof, data: btoa('x'.repeat(1048577)) } };
  assert.equal((await handler(uploadProof(large)).then(r => r.status)), 413);
});

test('preflight permits only the configured origin', async () => {
  const allowed = await handler(new Request('https://example.com', { method: 'OPTIONS', headers: { origin: 'https://shop.example' } }));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://shop.example');
  const denied = await handler(uploadProof(order(), { origin: 'https://unrelated.example' }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('database stock conflicts are actionable and do not schedule email', async () => {
  rpcResults.place_order = { message: 'OUT_OF_STOCK' };
  const response = await submit();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'OUT_OF_STOCK');
  assert.equal(jobs.length, 0);
  assert.equal(proofObjects.size, 0, 'proofs for rejected orders are removed from private storage');
});

test('changed prices require customer review', async () => {
  rpcResults.place_order = { message: 'PRICE_CHANGED' };
  const response = await submit();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'PRICE_CHANGED');
});

test('reused keys and invalid database inputs get definitive rejections', async () => {
  for (const [message, status] of [['KEY_REUSED',409], ['INVALID_SIZE',400], ['INVALID_BUNDLE',400]]) {
    rpcResults.place_order = { message };
    assert.equal((await submit()).status, status);
  }
});

test('network failures preserve the uncertainty needed for safe retries', async () => {
  rpcResults.place_order = new Error('network disconnected');
  const response = await submit();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /same order/);
});

test('rate limit stops requests before order creation', async () => {
  rpcResults.take_checkout_slot = false;
  assert.equal((await handler(uploadProof(order())).then(async response => response.status)), 429);
  assert.equal(calls.some(c => c.name === 'place_order'), false);
});

test('production checkout refuses to open without an email adapter', async () => {
  variables.set('ALLOW_EMAIL_QUEUE_ONLY', 'false');
  assert.equal((await handler(uploadProof(order())).then(async response => response.status)), 503);
  assert.equal(calls.length, 0);
});

test('email failures keep successful orders and record a retryable failure', async () => {
  variables.set('EMAIL_WEBHOOK_URL', 'https://mail.example/send');
  variables.set('EMAIL_WEBHOOK_TOKEN', 'mail-secret');
  rpcResults.claim_emails = [{ order_id: 'order-1', lease_token: 'lease-1', email: 'student@example.com', status: 'placed' }];
  webhookStatus = 503;
  assert.equal((await submit()).status, 200);
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
