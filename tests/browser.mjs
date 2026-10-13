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
  const cors = { 'access-control-allow-origin': base, 'access-control-allow-headers': 'apikey, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://supabase.test/rest/v1/products?**', route => route.fulfill({ headers: cors, json: catalog }));
  await page.route('https://supabase.test/rest/v1/shop_settings?**', route => route.fulfill({ headers: cors, json: [{ id: true, orders_open: true, pickup_address: 'Test pickup address', bundle_three_cents: 399, bundle_five_cents: 999 }] }));
  const attempts = [];
  let loseFirstResponse = true;
  await page.route('https://supabase.test/functions/v1/checkout', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = route.request().postDataJSON();
    attempts.push(body);
    if (loseFirstResponse) { loseFirstResponse = false; await route.abort('failed'); return; }
    await route.fulfill({ headers: cors, json: { email_status: 'queued', order: { id: '00000000-0000-4000-8000-000000000001', total_cents: body.expected_total_cents, pickup_address: 'Test pickup address', status: 'placed', lines: [{ name: 'Crewneck Sweatshirt', quantity: 1, size: 'XS', total_cents: 2999, preorder: true }, { name: '3-sticker pack', quantity: 1, total_cents: 399, preorder: false }] } } });
  });
  await page.goto(base);
  await page.getByText('50 available', { exact: true }).waitFor();
  assert.equal(await page.locator('.product-card').count(), 9);
  const stickerCard = page.locator('.product-card').filter({ has: page.getByRole('heading', { name: 'Sticker 1', exact: true }) });
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
  await page.getByLabel('Crewneck Sweatshirt size').selectOption('XS');
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
  assert.match(await page.locator('.order-total').innerText(), /33.98/);
  await page.getByLabel('Your email', { exact: true }).fill('student@localhost');
  await page.getByRole('button', { name: 'Place pickup order' }).click();
  await page.getByText('Enter a valid email address, such as you@example.com.', { exact: true }).waitFor();
  assert.equal(attempts.length, 0, 'invalid email must not start checkout');
  await page.getByLabel('Your email', { exact: true }).fill('student@example.com');
  await page.getByRole('button', { name: 'Place pickup order' }).click();
  await page.getByRole('button', { name: 'Retry this order safely' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Retry this order safely' }).click();
  await page.getByText('A little AIMS, reserved.', { exact: true }).waitFor();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1], 'retry after reload must preserve key, email, total, and selections');
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
