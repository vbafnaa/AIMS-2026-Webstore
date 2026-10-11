-- Examples for the Supabase SQL editor. Replace placeholders before running.
-- Open checkout only after the Edge Function and email delivery are configured:
-- update public.shop_settings
-- set pickup_address = 'YOUR DESIGNATED PICKUP ADDRESS', orders_open = true where id;

-- Cancel AND restock atomically. Never cancel by editing the status cell:
-- select public.cancel_order('ORDER-UUID-HERE'::uuid);

-- Mark an order collected without changing inventory:
-- update public.orders set status = 'collected' where id = 'ORDER-UUID-HERE'::uuid and status = 'placed';

-- Notifications needing attention (8 unsuccessful attempts):
-- select o.id, o.email, e.attempts, e.last_error from public.email_outbox e
-- join public.orders o on o.id = e.order_id where e.sent_at is null and e.attempts >= 8;

-- Retry a failed notification after fixing delivery (retains provider idempotency key):
-- update public.email_outbox set attempts = 0, next_attempt_at = now(), lease_until = null,
-- lease_token = null where order_id = 'ORDER-UUID-HERE'::uuid and sent_at is null;

-- Periodically remove expired rate-limit buckets:
-- delete from public.checkout_limits where window_start < now() - interval '1 day';
