-- Never overwrite live inventory when re-running the seed.
insert into public.products(id,name,category,price_cents,stock,preorder,sizes) values
('sticker-1','Sticker 1','stickers',299,200,false,'{}'),
('sticker-2','Sticker 2','stickers',299,200,false,'{}'),
('sticker-3','Sticker 3','stickers',299,100,false,'{}'),
('sticker-4','Sticker 4','stickers',299,100,false,'{}'),
('sticker-5','Sticker 5','stickers',299,200,false,'{}'),
('cap','Cap','wear',1999,50,false,'{}'),
('crewneck','Crewneck Sweatshirt','wear',3499,null,true,'{S,M,L,XL,XXL}'),
('keychain-1','3D Printed Keychain 1','keychains',199,20,false,'{}'),
('keychain-2','3D Printed Keychain 2','keychains',199,40,false,'{}')
on conflict (id) do nothing;
-- Promotion metadata only; never reset available stock.
-- Includes Oct 29, 2026 in Seattle; expires Oct 30 at 00:00 PDT.
update public.products set early_bird_price_cents = 1499, early_bird_ends_at_epoch = 1793343600 where id = 'cap';
update public.products set price_cents = 3499, early_bird_price_cents = 2999, early_bird_ends_at_epoch = 1793343600, sizes = '{S,M,L,XL,XXL}' where id = 'crewneck';
insert into public.shop_settings(id) values (true) on conflict (id) do nothing;
update public.shop_settings set bundle_three_cents = 599, bundle_five_cents = 999 where id = true;
