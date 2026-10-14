import { EARLY_BIRD_END_EPOCH } from '../lib/pricing.ts';

export type Product = {
  id: string;
  name: string;
  detail: string;
  material_detail: string;
  specifications: string[];
  category: 'stickers' | 'wear' | 'keychains';
  image: string;
  gallery: string[];
  price_cents: number;
  early_bird_price_cents?: number | null;
  early_bird_ends_at_epoch?: number | null;
  stock: number | null;
  preorder: boolean;
  sizes: string[];
  active: boolean;
};

export const catalog: Product[] = [
  { id: 'sticker-1', name: 'Sticker 1', detail: 'A little Washington pride.', material_detail: 'Premium 3.15 mil matte-white PVC, custom die-cut with a protective matte laminate and vibrant CMYK printing.', specifications: ['Dimensions: 3 × 1.6 in', 'Material: 3.15 mil matte-white PVC', 'Finish: custom die-cut with matte surface lamination', 'Print: vibrant CMYK, full-color process'], category: 'stickers', image: 'sticker-1-washington-skyline', gallery: [], price_cents: 299, stock: 200, preorder: false, sizes: [], active: true },
  { id: 'sticker-2', name: 'Sticker 2', detail: 'Seattle, in your corner.', material_detail: 'Premium 3.15 mil matte-white PVC, custom die-cut with a protective matte laminate and vibrant CMYK printing.', specifications: ['Dimensions: 3 × 3 in', 'Material: 3.15 mil matte-white PVC', 'Finish: custom die-cut with matte surface lamination', 'Print: vibrant CMYK, full-color process'], category: 'stickers', image: 'sticker-2-seattle-skyline', gallery: [], price_cents: 299, stock: 200, preorder: false, sizes: [], active: true },
  { id: 'sticker-3', name: 'Sticker 3', detail: 'Husky spirit. Classic purple.', material_detail: 'Premium 3.15 mil matte-white PVC, custom die-cut with a protective matte laminate and vibrant CMYK printing.', specifications: ['Dimensions: 3 × 3 in', 'Material: 3.15 mil matte-white PVC', 'Finish: custom die-cut with matte surface lamination', 'Print: vibrant CMYK, full-color process'], category: 'stickers', image: 'sticker-3-purple-husky', gallery: [], price_cents: 299, stock: 100, preorder: false, sizes: [], active: true },
  { id: 'sticker-4', name: 'Sticker 4', detail: 'A Husky with a heart of gold.', material_detail: 'Premium 3.15 mil matte-white PVC, custom die-cut with a protective matte laminate and vibrant CMYK printing.', specifications: ['Dimensions: 3 × 3 in', 'Material: 3.15 mil matte-white PVC', 'Finish: custom die-cut with matte surface lamination', 'Print: vibrant CMYK, full-color process'], category: 'stickers', image: 'sticker-4-gold-husky', gallery: [], price_cents: 299, stock: 100, preorder: false, sizes: [], active: true },
  { id: 'sticker-5', name: 'Sticker 5', detail: 'Greetings from Mount Rainier.', material_detail: 'Premium 3.15 mil matte-white PVC, custom die-cut with a protective matte laminate and vibrant CMYK printing.', specifications: ['Dimensions: 3 × 2.4 in', 'Material: 3.15 mil matte-white PVC', 'Finish: custom die-cut with matte surface lamination', 'Print: vibrant CMYK, full-color process'], category: 'stickers', image: 'sticker-5-mount-rainier-stamp', gallery: [], price_cents: 299, stock: 200, preorder: false, sizes: [], active: true },
  { id: 'cap', name: 'Cap', detail: 'Keeping the human in the loop.', material_detail: 'Off-white washed cotton with dark-green embroidery, finished with an adjustable antique-brass-tone buckle.', specifications: ['Material: 100% washed cotton', 'Color: off-white with dark-green embroidery', 'Construction: six-panel, soft unstructured crown with curved visor', 'Fit: one size fits all; adjustable 22–23.6 in head circumference', 'Closure: fabric strap with adjustable antique-brass-tone metal buckle'], category: 'wear', image: 'cap', gallery: ['cap-design'], price_cents: 1999, early_bird_price_cents: 1499, early_bird_ends_at_epoch: EARLY_BIRD_END_EPOCH, stock: 50, preorder: false, sizes: [], active: true },
  { id: 'crewneck', name: 'Crewneck Sweatshirt', detail: 'Made for our community. Made to order.', material_detail: 'Hanes® 7.8 oz, 50/50 cotton-poly fleece in ash with a purple print; pill-resistant and made for lasting comfort.', specifications: ['Fabric: 7.8 oz, 50/50 cotton-polyester blend', 'Color: ash with purple print', 'Finish: comfortable, pill-resistant fleece', 'Details: rib-knit collar, cuffs, and waistband; set-in sleeves', 'Construction: durable double-needle stitching', 'Sizes: S–2XL'], category: 'wear', image: 'crewneck-sweatshirt', gallery: ['crewneck-sweatshirt-front-design', 'crewneck-sweatshirt-back-design'], price_cents: 3499, early_bird_price_cents: 2999, early_bird_ends_at_epoch: EARLY_BIRD_END_EPOCH, stock: null, preorder: true, sizes: ['S', 'M', 'L', 'XL', 'XXL'], active: true },
  { id: 'keychain-1', name: '3D Printed Keychain 1', detail: 'MSIM × iSchool. Take it with you.', material_detail: 'A precision-finished black-and-white 3D print with an interchangeable key ring and chain attachment.', specifications: ['Dimensions: 1.5 × 1.5 in', 'Design: black-and-white MSIM × iSchool', 'Craft: precision 3D-printed finish', 'Attachment: interchangeable key ring and chain'], category: 'keychains', image: 'keychain-1-msim-ischool', gallery: ['keychain-1-msim-ischool-render'], price_cents: 199, stock: 20, preorder: false, sizes: [], active: true },
  { id: 'keychain-2', name: '3D Printed Keychain 2', detail: 'Your keys. Your community.', material_detail: 'A precision-finished black-and-white 3D print with an interchangeable key ring and chain attachment.', specifications: ['Dimensions: 0.8 × 1.5 in', 'Design: black-and-white MSIM tag', 'Craft: precision 3D-printed finish', 'Attachment: interchangeable key ring and chain'], category: 'keychains', image: 'keychain-2-msim-tag', gallery: ['keychain-2-msim-tag-render'], price_cents: 199, stock: 40, preorder: false, sizes: [], active: true },
];

export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
