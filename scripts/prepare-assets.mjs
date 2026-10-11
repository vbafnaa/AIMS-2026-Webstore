import sharp from 'sharp';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

// Matched visually against the PDF, not by the source file's number.
const files = [
  ['msim-stickers-print-01.png', 'sticker-1-washington-skyline', true],
  ['msim-stickers-print-02.png', 'sticker-2-seattle-skyline', true],
  ['msim-stickers-print-05.png', 'sticker-3-purple-husky', true],
  ['msim-stickers-print-04.png', 'sticker-4-gold-husky', true],
  ['msim-stickers-print-03.png', 'sticker-5-mount-rainier-stamp', true],
  ['cap.png', 'cap', false],
  ['cap design.png', 'cap-design', true],
  ['crewneck sweatshirt 2.png', 'crewneck-sweatshirt', false],
  ['crewneck sweatshirt 1.png', 'crewneck-sweatshirt-alternate', false],
  ['crewneck sweatshirt front design.png', 'crewneck-sweatshirt-front-design', true],
  ['crewneck sweatshirt back design.png', 'crewneck-sweatshirt-back-design', true],
  ['3D Printed Keychain 1 - 1.jpg', 'keychain-1-msim-ischool', false],
  ['3D Printed Keychain 1 - 2.png', 'keychain-1-msim-ischool-render', false],
  ['3D Printed Keychain 2 - 1.jpg', 'keychain-2-msim-tag', false],
  ['3D Printed Keychain 2 - 2.png', 'keychain-2-msim-tag-render', false],
];
const out = resolve('public/images/products');
await mkdir(out, { recursive: true });
const manifest = {};
let sourceBytes = 0, primaryBytes = 0;
for (const [source, name, lossless] of files) {
  const input = resolve('AIMS Inventory', source);
  const metadata = await sharp(input).metadata();
  const longest = Math.max(metadata.width, metadata.height);
  const variants = [];
  for (const size of [400, 800, 1200]) {
    if (size !== 1200 && longest <= size) continue;
    const filename = `${name}${size === 1200 ? '' : `-${size}`}.webp`;
    const info = await sharp(input).rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .webp({ lossless, quality: 82, effort: 6 }).toFile(resolve(out, filename));
    variants.push({ src: `/images/products/${filename}`, width: info.width, height: info.height, bytes: info.size });
  }
  const primary = variants.at(-1);
  manifest[name] = { source, ...primary, variants, lossless, alpha: metadata.hasAlpha };
  sourceBytes += (await stat(input)).size;
  primaryBytes += primary.bytes;
}
await mkdir('src/data', { recursive: true });
await writeFile('src/data/assets.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`Converted ${files.length} images. Originals: ${(sourceBytes/1024/1024).toFixed(2)} MB; primary WebPs: ${(primaryBytes/1024/1024).toFixed(2)} MB (${Math.round((1-primaryBytes/sourceBytes)*100)}% smaller).`);
