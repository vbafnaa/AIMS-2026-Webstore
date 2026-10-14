begin;

update public.products
set price_cents = 3499,
    early_bird_price_cents = 2999,
    early_bird_ends_at_epoch = 1793343600,
    sizes = '{S,M,L,XL,XXL}'
where id = 'crewneck';

update public.shop_settings
set bundle_five_cents = 749
where id = true;

commit;
