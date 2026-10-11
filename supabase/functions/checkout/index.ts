// No dependencies or browser-exposed privileged keys.
const env = (key: string) => Deno.env.get(key) ?? '';
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
    'Access-Control-Allow-Headers': 'content-type, apikey', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    if (!req.headers.get('content-type')?.startsWith('application/json')) return respond({ error: 'Expected JSON.' }, 415);
    // Bound the stream, not only Content-Length (which clients can omit).
    const reader = req.body?.getReader();
    if (!reader) return respond({ error: 'Missing order.' }, 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16384) { await reader.cancel(); return respond({ error: 'Order is too large.' }, 413); }
      chunks.push(value);
    }
    const raw = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return respond({ error: 'Invalid order.' }, 400); }
    if (!body || typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
        typeof body.key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.key) ||
        !Number.isSafeInteger(body.expected_total_cents) || body.expected_total_cents < 1 ||
        !Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 50) return respond({ error: 'Check your email and selected items.' }, 400);
    if ((!env('EMAIL_WEBHOOK_URL') || !env('EMAIL_WEBHOOK_TOKEN')) && env('ALLOW_EMAIL_QUEUE_ONLY') !== 'true') return respond({ error: 'Ordering is not available yet.' }, 503);
    const email = body.email.trim().toLowerCase();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
    const bucket = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (!await rpc('take_checkout_slot', { p_bucket: bucket })) return respond({ error: 'Too many attempts. Try again in 10 minutes.' }, 429);
    const order = await rpc('place_order', { p_key: body.key, p_email: email, p_lines: body.lines, p_expected_total: body.expected_total_cents });
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
