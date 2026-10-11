import { CAP_EARLY_BIRD_END_EPOCH } from '../lib/pricing.ts';

export type Product = {
  id: string;
  name: string;
  detail: string;
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
  { id: 'sticker-1', name: 'Sticker 1', detail: 'A little Washington pride.', category: 'stickers', image: 'sticker-1-washington-skyline', gallery: [], price_cents: 299, stock: 200, preorder: false, sizes: [], active: true },
  { id: 'sticker-2', name: 'Sticker 2', detail: 'Seattle, in your corner.', category: 'stickers', image: 'sticker-2-seattle-skyline', gallery: [], price_cents: 299, stock: 200, preorder: false, sizes: [], active: true },
  { id: 'sticker-3', name: 'Sticker 3', detail: 'Husky spirit. Classic purple.', category: 'stickers', image: 'sticker-3-purple-husky', gallery: [], price_cents: 299, stock: 100, preorder: false, sizes: [], active: true },
  { id: 'sticker-4', name: 'Sticker 4', detail: 'A Husky with a heart of gold.', category: 'stickers', image: 'sticker-4-gold-husky', gallery: [], price_cents: 299, stock: 100, preorder: false, sizes: [], active: true },
  { id: 'sticker-5', name: 'Sticker 5', detail: 'Greetings from Mount Rainier.', category: 'stickers', image: 'sticker-5-mount-rainier-stamp', gallery: [], price_cents: 299, stock: 200, preorder: false, sizes: [], active: true },
  { id: 'cap', name: 'Cap', detail: 'Keeping the human in the loop.', category: 'wear', image: 'cap', gallery: ['cap-design'], price_cents: 1999, early_bird_price_cents: 1499, early_bird_ends_at_epoch: CAP_EARLY_BIRD_END_EPOCH, stock: 50, preorder: false, sizes: [], active: true },
  { id: 'crewneck', name: 'Crewneck Sweatshirt', detail: 'Made for our community. Made to order.', category: 'wear', image: 'crewneck-sweatshirt', gallery: ['crewneck-sweatshirt-alternate', 'crewneck-sweatshirt-front-design', 'crewneck-sweatshirt-back-design'], price_cents: 2999, stock: null, preorder: true, sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'], active: true },
  { id: 'keychain-1', name: '3D Printed Keychain 1', detail: 'MSIM × iSchool. Take it with you.', category: 'keychains', image: 'keychain-1-msim-ischool', gallery: ['keychain-1-msim-ischool-render'], price_cents: 199, stock: 20, preorder: false, sizes: [], active: true },
  { id: 'keychain-2', name: '3D Printed Keychain 2', detail: 'Your keys. Your community.', category: 'keychains', image: 'keychain-2-msim-tag', gallery: ['keychain-2-msim-tag-render'], price_cents: 199, stock: 40, preorder: false, sizes: [], active: true },
];

export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
