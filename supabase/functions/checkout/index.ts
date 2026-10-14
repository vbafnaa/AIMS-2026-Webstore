// No dependencies or browser-exposed privileged keys.
const env = (key: string) => Deno.env.get(key) ?? '';
const maxProofBytes = 1_048_576;
const proofTypes: Record<string, { extension: string; signature: number[] }> = {
  'image/jpeg': { extension: 'jpg', signature: [0xff, 0xd8, 0xff] },
  'image/png': { extension: 'png', signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/webp': { extension: 'webp', signature: [0x52, 0x49, 0x46, 0x46] },
};
const rpc = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(25000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'DATABASE_ERROR');
  return data;
};

function validateProof(contentType: string, bytes: Uint8Array) {
  const image = proofTypes[contentType];
  if (!image) throw new Error('INVALID_PAYMENT_PROOF');
  if (bytes.length < image.signature.length || bytes.length > maxProofBytes ||
      !image.signature.every((byte, index) => bytes[index] === byte) ||
      (contentType === 'image/webp' && new TextDecoder().decode(bytes.slice(8, 12)) !== 'WEBP')) {
    throw new Error('INVALID_PAYMENT_PROOF');
  }
  return { bytes, contentType, extension: image.extension };
}

async function readLimitedBody(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

async function storeProof(key: string, proof: { bytes: Uint8Array; contentType: string; extension: string }) {
  const { bytes, contentType, extension } = proof;
  const path = `${key}.${extension}`;
  const objectUrl = `${env('SUPABASE_URL')}/storage/v1/object/payment-proofs/${path}`;
  const credentials = {
    apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
    Authorization: `******'SUPABASE_SERVICE_ROLE_KEY')}`,
  };
  const imageBuffer = new ArrayBuffer(bytes.length);
  new Uint8Array(imageBuffer).set(bytes);
  const response = await fetch(objectUrl, {
    method: 'POST',
    headers: {
      ...credentials,
      'Content-Type': contentType,
    },
    body: imageBuffer,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    // Resolve retries without allowing a reused key to overwrite an already stored proof.
    const existing = await fetch(objectUrl, { headers: credentials, signal: AbortSignal.timeout(10000) });
    if (!existing.ok) throw new Error('PROOF_UPLOAD_FAILED');
    const storedBytes = new Uint8Array(await existing.arrayBuffer());
    if (storedBytes.length !== bytes.length || !storedBytes.every((byte, index) => byte === bytes[index])) {
      throw new Error('KEY_REUSED');
    }
  }
  return path;
}

async function hasValidStoredProof(path: string, extension: string) {
  const response = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/payment-proofs/${path}`, {
    headers: {
      apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `******'SUPABASE_SERVICE_ROLE_KEY')}`,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return false;
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return validateProof(`image/${extension === 'jpg' ? 'jpeg' : extension}`, bytes).extension === extension;
  } catch {
    return false;
  }
}

async function removeProof(path: string) {
  const response = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/payment-proofs/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `******'SUPABASE_SERVICE_ROLE_KEY')}`,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok && response.status !== 404) throw new Error('PROOF_CLEANUP_FAILED');
}

async function dispatchEmails() {
  if (!env('EMAIL_WEBHOOK_URL') || !env('EMAIL_WEBHOOK_TOKEN')) return { configured: false, sent: 0 };
  const pending = await rpc('claim_emails');
  let sent = 0;
  for (const message of pending) {
    let ok = false;
    try {
      const { lease_token: _token, ...payload } = message;
      const response = await fetch(env('EMAIL_WEBHOOK_URL'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('EMAIL_WEBHOOK_TOKEN')}`, 'Content-Type': 'application/json', 'Idempotency-Key': `order-${message.order_id}` },
        body: JSON.stringify({ type: message.status === 'cancelled' ? 'order-cancelled' : 'order-confirmation', ...payload }),
        signal: AbortSignal.timeout(10000),
      });
      ok = response.ok;
    } catch { /* Keep the order and retry delivery later. */ }
    await rpc('finish_email', { p_order_id: message.order_id, p_token: message.lease_token, p_success: ok, p_error: ok ? null : 'Email adapter did not confirm delivery' });
    if (ok) sent++;
  }
  return { configured: true, sent };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  const allowed = env('ALLOWED_ORIGIN');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'content-type, apikey, x-payment-proof-key, x-payment-proof-email', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (origin === allowed) headers['Access-Control-Allow-Origin'] = allowed;
  const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);
  try {
    // Scheduler authentication is independent of browser checkout.
    const isDispatcher = env('EMAIL_DISPATCH_SECRET') && req.headers.get('authorization') === `Bearer ${env('EMAIL_DISPATCH_SECRET')}`;
    if (isDispatcher) return respond(await dispatchEmails());
    if (!allowed || origin !== allowed) return respond({ error: 'Origin not allowed.' }, 403);
    const contentType = req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (proofTypes[contentType]) {
      if ((!env('EMAIL_WEBHOOK_URL') || !env('EMAIL_WEBHOOK_TOKEN')) && env('ALLOW_EMAIL_QUEUE_ONLY') !== 'true') {
        return respond({ error: 'Ordering is not available yet.' }, 503);
      }
      const key = req.headers.get('x-payment-proof-key') ?? '';
      const proofEmail = req.headers.get('x-payment-proof-email')?.trim().toLowerCase() ?? '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key) ||
          proofEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(proofEmail)) {
        return respond({ error: 'Invalid payment screenshot request.' }, 400);
      }
      const proofDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proofEmail));
      const proofBucket = `proof-${Array.from(new Uint8Array(proofDigest), b => b.toString(16).padStart(2, '0')).join('')}`;
      if (!await rpc('take_checkout_slot', { p_bucket: proofBucket })) return respond({ error: 'Too many attempts. Try again in 10 minutes.' }, 429);
      const bytes = await readLimitedBody(req, maxProofBytes);
      if (!bytes) return respond({ error: 'Payment screenshots must be smaller than 1 MB.' }, 413);
      try {
        const proof = validateProof(contentType, bytes);
        const paymentProofPath = await storeProof(key, proof);
        return respond({ payment_proof_path: paymentProofPath });
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'KEY_REUSED') return respond({ error: 'This checkout key already has a different payment screenshot.', code }, 409);
        if (code === 'INVALID_PAYMENT_PROOF') return respond({ error: 'Upload a valid PNG, JPG, or WEBP payment screenshot.' }, 400);
        throw error;
      }
    }
    if (contentType !== 'application/json') return respond({ error: 'Expected JSON or a supported image upload.' }, 415);
    // Bound JSON separately now that the image is sent as binary.
    const raw = await readLimitedBody(req, 32768);
    if (!raw) return respond({ error: 'Order is too large.' }, 413);
    let body;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return respond({ error: 'Invalid order.' }, 400); }
    if (!body || typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
        typeof body.key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.key) ||
        !Number.isSafeInteger(body.expected_total_cents) || body.expected_total_cents < 1 ||
        !Number.isSafeInteger(body.paid_total_confirmed_cents) || body.paid_total_confirmed_cents !== body.expected_total_cents ||
        !Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 50 ||
        typeof body.payment_proof_path !== 'string' ||
        !new RegExp(`^${body.key}\\.(jpg|png|webp)$`, 'i').test(body.payment_proof_path)) return respond({ error: 'Confirm payment of the displayed total and check your email, screenshot, and selected items.' }, 400);
    const customer = body.customer;
    if (!customer || typeof customer !== 'object' ||
        typeof customer.full_name !== 'string' || !customer.full_name.trim() || customer.full_name.trim().length > 120 ||
        typeof customer.phone_number !== 'string' || customer.phone_number.trim().length > 30 ||
        customer.phone_number.trim().replace(/\D/g, '').length < 7 || customer.phone_number.trim().replace(/\D/g, '').length > 15 ||
        !/^[+0-9 ().-]+$/.test(customer.phone_number.trim()) ||
        typeof customer.zelle_payer_name !== 'string' || !customer.zelle_payer_name.trim() || customer.zelle_payer_name.trim().length > 120 ||
        typeof customer.payment_reference !== 'string' || customer.payment_reference.length > 500 ||
        !['mgh_440', 'ianniversary_2026_10_29'].includes(customer.pickup_option)) return respond({ error: 'Complete your contact, payment, and pickup details.' }, 400);
    const proofPath = body.payment_proof_path;
    const proofExtension = proofPath.split('.').at(-1)!.toLowerCase();
    if (!await hasValidStoredProof(proofPath, proofExtension)) return respond({ error: 'Upload a valid payment screenshot before placing your order.' }, 400);
    if ((!env('EMAIL_WEBHOOK_URL') || !env('EMAIL_WEBHOOK_TOKEN')) && env('ALLOW_EMAIL_QUEUE_ONLY') !== 'true') return respond({ error: 'Ordering is not available yet.' }, 503);
    const email = body.email.trim().toLowerCase();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
    const bucket = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (!await rpc('take_checkout_slot', { p_bucket: bucket })) return respond({ error: 'Too many attempts. Try again in 10 minutes.' }, 429);
    let order;
    try {
      order = await rpc('place_order', {
        p_key: body.key,
        p_email: email,
        p_lines: body.lines,
        p_expected_total: body.expected_total_cents,
        p_full_name: customer.full_name.trim(),
        p_phone_number: customer.phone_number.trim(),
        p_zelle_payer_name: customer.zelle_payer_name.trim(),
        p_payment_reference: customer.payment_reference.trim(),
        p_pickup_option: customer.pickup_option,
        p_payment_proof_path: proofPath,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (/^(OUT_OF_STOCK|PRICE_CHANGED|SHOP_CLOSED|INVALID_)/.test(code)) {
        try { await removeProof(proofPath); }
        catch (cleanupError) { console.error('Could not remove a payment proof for a rejected order.', cleanupError); }
      }
      throw error;
    }
    // Durable outbox + scheduled dispatch guarantees retries if this process exits.
    EdgeRuntime.waitUntil(dispatchEmails().catch(() => console.error('Email dispatch failed; pending messages retained.')));
    return respond({ order, email_status: 'queued' });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code.includes('OUT_OF_STOCK')) return respond({ error: 'An item no longer has enough stock. Review the updated quantities.', code: 'OUT_OF_STOCK' }, 409);
    if (code.includes('KEY_REUSED')) return respond({ error: 'This checkout attempt was already used for a different order.', code: 'KEY_REUSED' }, 409);
    if (code.includes('PRICE_CHANGED')) return respond({ error: 'A price changed. Review the updated total before placing your order.', code: 'PRICE_CHANGED', server_epoch: Math.floor(Date.now() / 1000) }, 409);
    if (code.includes('SHOP_CLOSED')) return respond({ error: 'Ordering is not open yet.' }, 503);
    if (/INVALID_/.test(code)) return respond({ error: 'Check your items, sizes, and pack quantities.' }, 400);
    // A network failure can happen after commit: client must retain its key.
    return respond({ error: 'We could not confirm the result. Retry this same order to check it safely.' }, 503);
  }
});
