-- Declarative schema. Apply to an empty project, or generate migrations with
-- `supabase db diff -f shop` before deploying changes to an existing project.
create table public.products (
  id text primary key,
  name text not null,
  category text not null check (category in ('stickers','wear','keychains')),
  price_cents integer not null check (price_cents >= 0),
  early_bird_price_cents integer,
  early_bird_ends_at_epoch bigint,
  stock integer check (stock >= 0),
  preorder boolean not null default false,
  sizes text[] not null default '{}',
  active boolean not null default true,
  check ((preorder and stock is null) or (not preorder and stock is not null)),
  check ((early_bird_price_cents is null and early_bird_ends_at_epoch is null)
    or (early_bird_price_cents is not null and early_bird_ends_at_epoch is not null
      and early_bird_price_cents >= 0 and early_bird_price_cents < price_cents and early_bird_ends_at_epoch > 0))
);
create table public.shop_settings (
  id boolean primary key default true check (id),
  pickup_address text not null default '',
  orders_open boolean not null default false,
  bundle_three_cents integer not null default 399 check (bundle_three_cents > 0),
  bundle_five_cents integer not null default 999 check (bundle_five_cents > 0)
);
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  request jsonb not null,
  email text not null,
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  phone_number text not null check (length(trim(phone_number)) between 7 and 30),
  zelle_payer_name text not null check (length(trim(zelle_payer_name)) between 1 and 120),
  payment_reference text not null default '' check (length(payment_reference) <= 500),
  pickup_option text not null check (pickup_option in ('mgh_440','ianniversary_2026_10_29')),
  payment_proof_path text not null,
  total_cents integer not null check (total_cents > 0),
  pickup_address text not null,
  lines jsonb not null,
  status text not null default 'placed' check (status in ('placed','collected','cancelled')),
  created_at timestamptz not null default now()
);
create table public.order_items (
  order_id uuid not null references public.orders(id),
  product_id text not null references public.products(id),
  size text not null default '',
  quantity integer not null check (quantity > 0),
  finite_stock boolean not null,
  primary key (order_id, product_id, size)
);
create index order_items_product_idx on public.order_items(product_id);
create table public.email_outbox (
  order_id uuid primary key references public.orders(id),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text
);
create index email_outbox_pending_idx on public.email_outbox(next_attempt_at) where sent_at is null;
create table public.checkout_limits (
  bucket text primary key,
  window_start timestamptz not null,
  hits integer not null
);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 1048576, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.products enable row level security;
alter table public.shop_settings enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.email_outbox enable row level security;
alter table public.checkout_limits enable row level security;
revoke all on public.products, public.shop_settings, public.orders, public.order_items, public.email_outbox, public.checkout_limits from anon, authenticated;
grant select on public.products, public.shop_settings to anon, authenticated;
create policy catalog_read on public.products for select to anon, authenticated using (active);
create policy settings_read on public.shop_settings for select to anon, authenticated using (true);
grant all on public.products, public.shop_settings, public.orders, public.order_items, public.email_outbox, public.checkout_limits to service_role;

create function public.take_checkout_slot(p_bucket text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  insert into public.checkout_limits as limits values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    hits = case when limits.window_start < now() - interval '10 minutes' then 1 else limits.hits + 1 end,
    window_start = case when limits.window_start < now() - interval '10 minutes' then now() else limits.window_start end
  returning hits into n;
  return n <= 10;
end;
$$;

create function public.place_order(
  p_key uuid, p_email text, p_lines jsonb, p_expected_total integer,
  p_full_name text, p_phone_number text, p_zelle_payer_name text, p_payment_reference text,
  p_pickup_option text, p_payment_proof_path text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  existing public.orders;
  config public.shop_settings;
  product public.products;
  line jsonb;
  item jsonb;
  allocation jsonb := '[]';
  receipt jsonb := '[]';
  qty integer;
  bundle_qty integer;
  pack_size integer;
  item_size text;
  total integer := 0;
  line_total integer;
  pricing_epoch bigint;
  order_uuid uuid;
  requested record;
  normalized_email text := lower(trim(p_email));
  pickup_label text;
  request_body jsonb;
begin
  if p_key is null or normalized_email is null or length(normalized_email) > 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or p_full_name is null or length(trim(p_full_name)) not between 1 and 120
     or p_phone_number is null or length(trim(p_phone_number)) not between 7 and 30
     or length(regexp_replace(p_phone_number, '[^0-9]', '', 'g')) not between 7 and 15
     or trim(p_phone_number) !~ '^[+0-9 ().-]+$'
     or p_zelle_payer_name is null or length(trim(p_zelle_payer_name)) not between 1 and 120
     or coalesce(length(p_payment_reference), 0) > 500
     or (
       p_payment_proof_path is distinct from p_key::text || '.jpg'
       and p_payment_proof_path is distinct from p_key::text || '.png'
       and p_payment_proof_path is distinct from p_key::text || '.webp'
     ) then
    raise exception 'INVALID_ORDER' using errcode = 'P0001';
  end if;
  pickup_label := case p_pickup_option
    when 'mgh_440' then 'MGH 440'
    when 'ianniversary_2026_10_29' then 'iAnniversary — October 29, 3–6 PM'
    else null
  end;
  if pickup_label is null then raise exception 'INVALID_PICKUP'; end if;
  if jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > 50 then
    raise exception 'INVALID_ORDER';
  end if;
  request_body := jsonb_build_object(
    'email', normalized_email, 'lines', p_lines, 'expected_total_cents', p_expected_total,
    'full_name', trim(p_full_name), 'phone_number', trim(p_phone_number),
    'zelle_payer_name', trim(p_zelle_payer_name), 'payment_reference', trim(coalesce(p_payment_reference, '')),
    'pickup_option', p_pickup_option, 'payment_proof_path', p_payment_proof_path
  );
  -- Serialize retries of the same key, including retries after a lost response.
  perform pg_advisory_xact_lock(hashtextextended(p_key::text, 0));
  select * into existing from public.orders where idempotency_key = p_key;
  if found then
    if existing.request <> request_body then raise exception 'KEY_REUSED'; end if;
    return jsonb_build_object('id', existing.id, 'total_cents', existing.total_cents,
      'pickup_address', existing.pickup_address, 'status', existing.status, 'lines', existing.lines);
  end if;
  select * into config from public.shop_settings where id;
  if not found or not config.orders_open then
    raise exception 'SHOP_CLOSED';
  end if;

  -- Lock every referenced product in one consistent order before validation.
  perform p.id from public.products p where p.id in (
    select l->>'product_id' from jsonb_array_elements(p_lines) l where l->>'kind' = 'single'
    union
    select i->>'product_id' from jsonb_array_elements(p_lines) l,
      lateral jsonb_array_elements(case when jsonb_typeof(l->'items') = 'array' then l->'items' else '[]'::jsonb end) i
    where l->>'kind' = 'bundle'
  ) order by p.id for update;

  -- Capture trusted wall-clock epoch AFTER waiting for inventory locks. A
  -- transaction that waited across the deadline must use the regular price.
  pricing_epoch := floor(extract(epoch from clock_timestamp()))::bigint;
  for line in select value from jsonb_array_elements(p_lines) loop
    if line->>'kind' = 'single' then
      if coalesce(line->>'quantity','') !~ '^[1-9][0-9]?$' then raise exception 'INVALID_QUANTITY'; end if;
      qty := (line->>'quantity')::integer;
      select * into product from public.products where id = line->>'product_id' and active;
      if not found then raise exception 'INVALID_PRODUCT'; end if;
      item_size := coalesce(line->>'size', '');
      if (cardinality(product.sizes) > 0 and not (item_size = any(product.sizes)))
         or (cardinality(product.sizes) = 0 and item_size <> '') then raise exception 'INVALID_SIZE'; end if;
      line_total := qty * case
        when product.early_bird_price_cents is not null and pricing_epoch < product.early_bird_ends_at_epoch
          then product.early_bird_price_cents
        else product.price_cents end;
      allocation := allocation || jsonb_build_array(jsonb_build_object('product_id', product.id, 'size', item_size, 'quantity', qty));
      receipt := receipt || jsonb_build_array(jsonb_build_object('name', product.name, 'size', item_size,
        'quantity', qty, 'total_cents', line_total, 'preorder', product.preorder));
    elsif line->>'kind' = 'bundle' then
      if coalesce(line->>'size','') not in ('3','5') or jsonb_typeof(line->'items') is distinct from 'array' then raise exception 'INVALID_BUNDLE'; end if;
      pack_size := (line->>'size')::integer;
      if jsonb_array_length(line->'items') not between 1 and 5 then raise exception 'INVALID_BUNDLE'; end if;
      bundle_qty := 0;
      for item in select value from jsonb_array_elements(line->'items') loop
        if coalesce(item->>'quantity','') !~ '^[1-5]$' then raise exception 'INVALID_BUNDLE'; end if;
        qty := (item->>'quantity')::integer;
        select * into product from public.products where id = item->>'product_id' and active and category = 'stickers';
        if not found then raise exception 'INVALID_BUNDLE'; end if;
        bundle_qty := bundle_qty + qty;
        allocation := allocation || jsonb_build_array(jsonb_build_object('product_id', product.id, 'size', '', 'quantity', qty));
      end loop;
      if bundle_qty <> pack_size then raise exception 'INVALID_BUNDLE'; end if;
      line_total := case pack_size when 3 then config.bundle_three_cents else config.bundle_five_cents end;
      receipt := receipt || jsonb_build_array(jsonb_build_object('name', pack_size || '-sticker pack', 'quantity', 1,
        'total_cents', line_total, 'items', line->'items', 'preorder', false));
    else raise exception 'INVALID_ORDER';
    end if;
    total := total + line_total;
  end loop;

  if p_expected_total is distinct from total then raise exception 'PRICE_CHANGED'; end if;
  for requested in select a->>'product_id' as id, sum((a->>'quantity')::integer) as qty
    from jsonb_array_elements(allocation) a group by a->>'product_id' loop
    select * into product from public.products where id = requested.id;
    if requested.qty > 99 then raise exception 'INVALID_QUANTITY'; end if;
    if not product.preorder and product.stock < requested.qty then raise exception 'OUT_OF_STOCK'; end if;
  end loop;

  insert into public.orders(
    idempotency_key, request, email, full_name, phone_number, zelle_payer_name, payment_reference,
    pickup_option, payment_proof_path, total_cents, pickup_address, lines
  ) values (
    p_key, request_body, normalized_email, trim(p_full_name), trim(p_phone_number), trim(p_zelle_payer_name),
    trim(coalesce(p_payment_reference, '')), p_pickup_option, p_payment_proof_path, total, pickup_label, receipt
  ) returning id into order_uuid;
  insert into public.order_items(order_id, product_id, size, quantity, finite_stock)
    select order_uuid, a->>'product_id', a->>'size', sum((a->>'quantity')::integer)::integer, not p.preorder
    from jsonb_array_elements(allocation) a join public.products p on p.id = a->>'product_id'
    group by a->>'product_id', a->>'size', p.preorder;
  update public.products p set stock = p.stock - quantities.qty from (
    select product_id, sum(quantity)::integer as qty from public.order_items
    where order_id = order_uuid and finite_stock group by product_id
  ) quantities where p.id = quantities.product_id;
  insert into public.email_outbox(order_id) values (order_uuid);
  return jsonb_build_object('id', order_uuid, 'total_cents', total, 'pickup_address', config.pickup_address,
    'status', 'placed', 'lines', receipt);
end;
$$;

create function public.cancel_order(p_order_id uuid)
returns text language plpgsql security invoker set search_path = '' as $$
declare current_status text;
begin
  select status into current_status from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if current_status = 'cancelled' then return 'cancelled'; end if;
  if current_status <> 'placed' then raise exception 'ORDER_ALREADY_COLLECTED'; end if;
  perform p.id from public.products p join public.order_items i on i.product_id = p.id
    where i.order_id = p_order_id and i.finite_stock order by p.id for update of p;
  update public.products p set stock = p.stock + q.qty from (
    select product_id, sum(quantity)::integer qty from public.order_items
    where order_id = p_order_id and finite_stock group by product_id
  ) q where p.id = q.product_id;
  update public.orders set status = 'cancelled' where id = p_order_id;
  return 'cancelled';
end;
$$;

create function public.claim_emails()
returns jsonb language sql security invoker set search_path = '' as $$
  with candidates as (
    select order_id from public.email_outbox
    where sent_at is null and attempts < 8 and next_attempt_at <= now()
      and (lease_until is null or lease_until < now())
    order by next_attempt_at for update skip locked limit 10
  ), claimed as (
    update public.email_outbox e set attempts = attempts + 1, lease_token = gen_random_uuid(),
      lease_until = now() + interval '5 minutes'
    from candidates c where e.order_id = c.order_id returning e.*
  ) select coalesce(jsonb_agg(jsonb_build_object('order_id', o.id, 'email', o.email, 'full_name', o.full_name,
    'phone_number', o.phone_number, 'zelle_payer_name', o.zelle_payer_name, 'payment_reference', o.payment_reference,
    'pickup_option', o.pickup_option, 'pickup_address', o.pickup_address, 'payment_proof_path', o.payment_proof_path,
    'total_cents', o.total_cents, 'lines', o.lines, 'status', o.status, 'lease_token', c.lease_token)), '[]'::jsonb)
    from claimed c join public.orders o on o.id = c.order_id;
$$;

create function public.finish_email(p_order_id uuid, p_token uuid, p_success boolean, p_error text default null)
returns void language sql security invoker set search_path = '' as $$
  update public.email_outbox set
    sent_at = case when p_success then now() else null end,
    last_error = case when p_success then null else left(p_error, 200) end,
    next_attempt_at = now() + make_interval(secs => least(3600, (30 * power(2, attempts))::integer)),
    lease_until = null, lease_token = null
  where order_id = p_order_id and lease_token = p_token;
$$;

revoke execute on function public.place_order(uuid,text,jsonb,integer,text,text,text,text,text,text), public.cancel_order(uuid),
  public.take_checkout_slot(text), public.claim_emails(), public.finish_email(uuid,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.place_order(uuid,text,jsonb,integer,text,text,text,text,text,text), public.cancel_order(uuid),
  public.take_checkout_slot(text), public.claim_emails(), public.finish_email(uuid,uuid,boolean,text) to service_role;
