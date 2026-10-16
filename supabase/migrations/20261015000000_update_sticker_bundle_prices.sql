begin;

update public.shop_settings
set bundle_three_cents = 699,
    bundle_five_cents = 1099
where id = true;

commit;
