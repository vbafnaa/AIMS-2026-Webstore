import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

test('all catalog images exist, preserve aspect ratio and transparency, and avoid upscaling', async () => {
  const manifest = JSON.parse(await readFile(new URL('../src/data/assets.json', import.meta.url)));
  assert.equal(Object.keys(manifest).length, 15);
  let originalBytes = 0, webpBytes = 0;
  for (const asset of Object.values(manifest)) {
    const source = new URL(`../AIMS Inventory/${asset.source}`, import.meta.url);
    const original = await sharp(fileURLToPath(source)).metadata();
    originalBytes += (await stat(source)).size;
    webpBytes += asset.bytes;
    for (const variant of asset.variants) {
      const metadata = await sharp(fileURLToPath(new URL(`../public${variant.src}`, import.meta.url))).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.width, variant.width);
      assert.equal(metadata.height, variant.height);
      assert.ok(metadata.width <= original.width && metadata.height <= original.height);
      assert.ok(Math.max(metadata.width, metadata.height) <= 1200);
      assert.ok(Math.abs(metadata.width / metadata.height - original.width / original.height) < .01);
      if (original.hasAlpha && !(await sharp(fileURLToPath(source)).stats()).isOpaque) assert.equal(metadata.hasAlpha, true);
    }
  }
  assert.ok(webpBytes < originalBytes * .25);
});

test('sticker numbering follows the PDF rather than source filename order', async () => {
  const manifest = JSON.parse(await readFile(new URL('../src/data/assets.json', import.meta.url)));
  assert.equal(manifest['sticker-3-purple-husky'].source, 'msim-stickers-print-05.png');
  assert.equal(manifest['sticker-5-mount-rainier-stamp'].source, 'msim-stickers-print-03.png');
});
