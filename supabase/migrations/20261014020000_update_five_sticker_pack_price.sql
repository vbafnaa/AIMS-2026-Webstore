begin;

update public.shop_settings
set bundle_five_cents = 899
where id = true;

commit;
