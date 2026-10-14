import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { catalog } from '../src/data/catalog.ts';

// Uses mocked HTTP responses, not a production Supabase project.
const port = 4322;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/astro/bin/astro.mjs', 'dev', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, PUBLIC_SUPABASE_URL: 'https://supabase.test', PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-public-key' },
  stdio: ['ignore','pipe','pipe'],
});
let logs = '';
server.stdout.on('data', b => { logs += b; });
server.stderr.on('data', b => { logs += b; });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Preview did not start: ${logs}`);
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const cors = { 'access-control-allow-origin': base, 'access-control-allow-headers': 'apikey, content-type, x-payment-proof-key, x-payment-proof-email', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://supabase.test/rest/v1/products?**', route => route.fulfill({ headers: cors, json: catalog }));
  await page.route('https://supabase.test/rest/v1/shop_settings?**', route => route.fulfill({ headers: cors, json: [{ id: true, orders_open: true, pickup_address: 'Test pickup address', bundle_three_cents: 599, bundle_five_cents: 899 }] }));
  const attempts = [];
  const proofUploads = [];
  let loseFirstResponse = true;
  await page.route('https://supabase.test/functions/v1/checkout', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (route.request().headers()['content-type']?.startsWith('image/')) {
      proofUploads.push(route.request().headers()['x-payment-proof-key']);
      return route.fulfill({ headers: cors, json: { payment_proof_path: `${route.request().headers()['x-payment-proof-key']}.png` } });
    }
    const body = route.request().postDataJSON();
    attempts.push(body);
    if (loseFirstResponse) { loseFirstResponse = false; await route.abort('failed'); return; }
    await route.fulfill({ headers: cors, json: { email_status: 'queued', order: { id: '00000000-0000-4000-8000-000000000001', total_cents: body.expected_total_cents, pickup_address: 'Test pickup address', status: 'placed', lines: [{ name: 'Crewneck Sweatshirt', quantity: 1, size: 'S', total_cents: 2999, preorder: true }, { name: '3-sticker pack', quantity: 1, total_cents: 599, preorder: false }] } } });
  });
  await page.goto(base);
  await page.getByAltText('Zelle payment QR code for AIMS at ainforms@uw.edu').waitFor();
  assert.match(await page.locator('.pack-options button').nth(0).innerText(), /5\.99/);
  assert.match(await page.locator('.pack-options button').nth(1).innerText(), /8\.99/);
  await page.getByText('50 available', { exact: true }).waitFor();
  assert.equal(await page.locator('.product-card').count(), 9);
  const stickerCard = page.locator('.product-card').filter({ has: page.getByRole('heading', { name: 'Sticker 1', exact: true }) });
  await stickerCard.getByRole('button', { name: 'More information' }).click();
  const stickerDetails = stickerCard.getByRole('dialog', { name: 'Sticker 1' });
  await stickerDetails.getByText('Material: 3.15 mil matte-white PVC').waitFor();
  await stickerDetails.getByText('Finish: custom die-cut with matte surface lamination').waitFor();
  await stickerDetails.getByRole('button', { name: 'Close Sticker 1 details' }).click();
  await stickerCard.getByRole('button', { name: 'Add to order' }).click();
  await stickerCard.getByRole('button', { name: 'Increase Sticker 1 in collection' }).click();
  await stickerCard.getByRole('button', { name: 'Increase Sticker 1 in collection' }).click();
  await page.getByText('Three or more individual stickers cost more than a pack.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Decrease Sticker 1 in your order' }).click();
  await page.getByRole('button', { name: 'Decrease Sticker 1 in your order' }).click();
  await page.getByRole('button', { name: 'Decrease Sticker 1 in your order' }).click();
  assert.equal(await page.locator('.count-badge').innerText(), '0');
  await page.getByRole('button', { name: 'Wear it', exact: true }).click();
  assert.equal(await page.locator('.product-card').count(), 2);
  const capCard = page.locator('.product-card').filter({ has: page.getByRole('heading', { name: 'Cap', exact: true }) });
  await capCard.getByRole('button', { name: 'More information' }).click();
  const capDetails = capCard.getByRole('dialog', { name: 'Cap' });
  await capDetails.getByText(/100% washed cotton/).waitFor();
  await capDetails.getByText(/22–23.6 in head circumference/).waitFor();
  await capDetails.getByRole('button', { name: 'Close Cap details' }).click();
  await page.getByLabel('Crewneck Sweatshirt size').selectOption('S');
  await page.locator('.product-card').filter({ has: page.getByRole('heading', { name: 'Crewneck Sweatshirt', exact: true }) }).getByRole('button', { name: 'Add to order' }).click();
  await page.getByRole('button', { name: 'Stickers', exact: true }).click();
  const stickerChoice = page.getByRole('combobox', { name: 'Sticker 1 in pack', exact: true });
  await stickerChoice.click();
  const thumbnail = page.getByRole('option', { name: 'Sticker 1', exact: true }).locator('img');
  assert.ok(await thumbnail.evaluate(image => {
    const bounds = image.getBoundingClientRect();
    const expected = parseFloat(getComputedStyle(image).fontSize) * 5;
    return Math.abs(bounds.width - expected) < 1 && Math.abs(bounds.height - expected) < 1;
  }), 'dropdown thumbnails must be 5em square');
  await stickerChoice.press('ArrowDown');
  await stickerChoice.press('Enter');
  assert.match(await stickerChoice.innerText(), /Sticker 2/);
  assert.equal(await stickerChoice.getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: 'Add 3-sticker pack' }).click();
  assert.match(await page.locator('.order-total').innerText(), /35.98/);
  const paymentConfirmation = page.getByLabel(/I confirm that I have paid the order total/);
  assert.equal(await page.getByRole('button', { name: 'Place pickup order' }).isDisabled(), true, 'checkout must stay disabled until payment is confirmed');
  await paymentConfirmation.check();
  await page.locator('.product-card').filter({ hasText: 'Cap' }).getByRole('button', { name: 'Add to order' }).click();
  assert.equal(await paymentConfirmation.isChecked(), false, 'changing the order must clear its payment confirmation');
  assert.equal(await page.getByRole('button', { name: 'Place pickup order' }).isDisabled(), true);
  await page.locator('.order-lines li').filter({ hasText: 'Cap' }).getByRole('button', { name: 'Remove Cap' }).click();
  await page.getByLabel('Your email', { exact: true }).fill('student@localhost');
  await page.getByRole('button', { name: 'Place pickup order' }).click();
  await page.getByText('Enter a valid email address, such as you@example.com.', { exact: true }).waitFor();
  assert.equal(attempts.length, 0, 'invalid email must not start checkout');
  await page.getByLabel('Your email', { exact: true }).fill('student@example.com');
  await page.getByLabel('Confirm email').fill('different@example.com');
  await page.getByRole('button', { name: 'Place pickup order' }).click();
  await page.getByText('The email addresses must match.', { exact: true }).waitFor();
  assert.equal(attempts.length, 0, 'mismatched email must not start checkout');
  await page.getByLabel('Confirm email').fill('student@example.com');
  await page.getByRole('button', { name: 'Place pickup order' }).click();
  await page.getByText('Enter your full name (up to 120 characters).', { exact: true }).waitFor();
  assert.equal(attempts.length, 0, 'required customer and payment details must block checkout');
  await page.getByLabel('Full name').fill('Student Example');
  await page.getByLabel('Phone number').fill('+1 206 555 0100');
  await page.getByLabel('Confirm phone number').fill('+1 206 555 0199');
  await page.getByLabel('Zelle payer name').fill('Student Example');
  await page.locator('#pickup-ianniversary_2026_10_29').check();
  await page.locator('#payment-proof').setInputFiles({ name: 'proof.png', mimeType: 'image/png', buffer: Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) });
  await page.getByText('Selected: proof.png', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Place pickup order' }).click();
  await page.getByText('Enter the same phone number in both fields.', { exact: true }).waitFor();
  assert.equal(attempts.length, 0, 'mismatched phone number must not start checkout');
  await page.getByLabel('Confirm phone number').fill('1 (206) 555-0100');
  await paymentConfirmation.check();
  await page.getByRole('button', { name: 'Place pickup order' }).click();
  await page.getByRole('button', { name: 'Retry this order safely' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Retry this order safely' }).click();
  await page.getByText('A little AIMS, reserved.', { exact: true }).waitFor();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1], 'retry after reload must preserve key, email, total, and selections');
  assert.equal(attempts[0].customer.full_name, 'Student Example');
  assert.equal(attempts[0].customer.phone_number, '+1 206 555 0100');
  assert.equal(attempts[0].customer.zelle_payer_name, 'Student Example');
  assert.equal(attempts[0].customer.pickup_option, 'ianniversary_2026_10_29');
  assert.equal(attempts[0].payment_proof_path, `${attempts[0].key}.png`);
  assert.equal(proofUploads.length, 2, 'safe retry re-uploads proof under its original idempotency key');
  assert.equal(await page.locator('.count-badge').innerText(), '0');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile must not overflow horizontally');
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: catalog, filters, sizing, packs, totals, lost-response retry, mobile layout.');
} finally {
  await browser?.close();
  server.kill();
}
