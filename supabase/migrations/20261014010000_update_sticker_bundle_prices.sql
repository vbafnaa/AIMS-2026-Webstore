begin;

update public.shop_settings
set bundle_three_cents = 599,
    bundle_five_cents = 899
where id = true;

commit;
