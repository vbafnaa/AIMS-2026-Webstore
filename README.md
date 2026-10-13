# AIMS merch shop

A single-page pickup shop built with Astro, React, Tailwind, and Supabase. Static HTML for the page; one hydrated React shop; plain `fetch` for Supabase reads and checkout. No client-side Supabase SDK, accounts, payment processor, or realtime connection.

Customers choose items, provide contact and Zelle payment details, upload a payment screenshot, and select a pickup location. Stock is committed when an order is placed. Sweatshirts are made-to-order preorders with no finite stock.

## Run locally

Requires Node 22.18+ (Node 24 recommended for the TypeScript test runner).

```sh
npm ci
cp .env.example .env
npm run dev
```

Open the printed local URL. Without credentials, the site is a browsable preview with checkout disabled. No fake orders are created. Set these public variables in `.env` to connect a project:

```dotenv
PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR-PUBLISHABLE-KEY
```

These values are intentionally public. Never put a service-role key in an Astro `PUBLIC_` variable. Restart development or rebuild static output after changing environment variables.

## Connect Supabase

1. Create an empty Supabase project. Run `supabase/schemas/001_shop.sql` in its SQL editor, then `supabase/seed.sql`. The schema is intended for an empty project; it is not a repeatable upgrade script. The seed uses `ON CONFLICT DO NOTHING` so it cannot reset sold stock.
2. The repository uses Supabase's [declarative schema workflow](https://supabase.com/docs/guides/local-development/declarative-database-schemas). For subsequent changes, edit `supabase/schemas/`, generate and review a migration using the installed CLI's `db diff` command, and apply it through your normal migration workflow. Consult `supabase --help` and subcommand help for your installed CLI version. Do not rerun the initial schema on a populated project.
3. Deploy `supabase/functions/checkout/index.ts` as the `checkout` Edge Function. `supabase/config.toml` disables JWT verification because this is a guest checkout. The function applies its own validation, origin check, and per-email rate limit. The notification dispatcher separately requires a secret bearer token.
4. Configure the function secrets described in `supabase/.env.functions.example`. Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in its Edge runtime. Set `ALLOWED_ORIGIN` to the exact frontend origin, without a trailing slash (for local development, `http://127.0.0.1:4321`).
5. Configure email delivery and scheduling below. Run the real database tests against a disposable project and inspect Supabase's security advisors before launch.
6. In `shop_settings`, set `orders_open = true`. Checkout offers MGH 440 (pickup time coordinated by email) and iAnniversary on October 29, 3–6 PM. All customer-facing prices include exactly the listed item prices, in USD; there is no shipping or additional tax calculation in this implementation.

The catalog and settings have read-only public access. Orders, contact details, Zelle information, payment references, proof-image paths, line items, rate-limit buckets, and notification records have RLS enabled and no anonymous access. The `payment-proofs` Storage bucket is private and accepts only PNG, JPG, and WEBP images up to 1 MB. The checkout Edge Function validates the image and uploads it with the server-only service role; the order row stores its private object path. Privileged functions are `SECURITY INVOKER`, with execute access revoked from `PUBLIC`, `anon`, and `authenticated`; only the backend service role can call them.

For an existing project, prepare and review a migration for the order contact/payment/pickup columns, private Storage bucket, and new `place_order` signature before deploying the updated Edge Function. Do not rerun the initial schema on a live project. The live Supabase project is not changed by edits in this repository.

## Checkout contract and concurrency

`POST /functions/v1/checkout` accepts:

```json
{
  "key": "a-client-generated-uuid",
  "email": "customer@example.com",
  "customer": {
    "full_name": "Customer Name",
    "phone_number": "+1 206 555 0100",
    "zelle_payer_name": "Customer Name",
    "payment_reference": "Optional payment memo",
    "pickup_option": "mgh_440"
  },
  "payment_proof_path": "<private path returned by binary screenshot upload>",
  "expected_total_cents": 3398,
  "lines": [
    { "kind": "single", "product_id": "crewneck", "quantity": 1, "size": "XS" },
    { "kind": "bundle", "size": 3, "items": [
      { "product_id": "sticker-1", "quantity": 2 },
      { "product_id": "sticker-3", "quantity": 1 }
    ] }
  ]
}
```

Full name, phone number, Zelle payer name, pickup choice, and payment screenshot are required. Payment reference/memo is optional. The browser sends the screenshot as a separate raw-binary request (not Base64 in the order JSON), in PNG, JPG, or WEBP format, up to 1 MB. Images are kept in the private `payment-proofs` bucket; the order row records the image path and customer/pickup details. The browser keeps an unresolved checkout and screenshot in session storage so retrying after a lost response uses the same idempotency key and details. Sweatshirt distribution depends on the number of orders; timing is communicated to the email address on the order.

The database calculates prices independently. The submitted total is only an equality check: changed prices produce a conflict and require the customer to review the new total. Each pack is a separate line; prices are 3 for $3.99 or 5 for $9.99 exactly as requested, without automatic best-price optimization.

`place_order` locks product rows in ID order, aggregates singles and packs by product, checks all stock, then inserts the order/items and decrements inventory in the same transaction. Any failure rolls back everything. A per-key advisory lock and unique key make simultaneous retries safe. A reused key with different contents is rejected. Quantities are positive integers, capped at 99 total units per product per order, and an order has at most 50 lines.

The browser retains an unresolved request in **sessionStorage**, including its customer details and screenshot, until the result is known. The form stays locked after an ambiguous network error; retrying after a reload uses the same request. Successful checkout or a definitive validation rejection clears the pending request. Closing the tab ends this recovery session, so customers should retry unresolved orders before closing it.

Success returns `{ order: { id, total_cents, pickup_address, status, lines }, email_status: "queued" }`. The screen shows the reference even if email is delayed. Other open pages may show stale stock until refreshed; the transaction remains authoritative.

## Email delivery (configure later)

See [EMAIL_README.md](EMAIL_README.md) for Google Workspace/Gmail authorization, the Resend alternative, adapter configuration, scheduling, and delivery checks.

No email provider was selected. The implementation has a **durable outbox and a provider-neutral adapter contract**, not a configured sending service. Set:

- `EMAIL_WEBHOOK_URL`: HTTPS endpoint you control that sends through your chosen email provider.
- `EMAIL_WEBHOOK_TOKEN`: secret bearer token your adapter validates.
- `EMAIL_DISPATCH_SECRET`: independent, long random secret for the scheduler.
- `ALLOW_EMAIL_QUEUE_ONLY=false` for production. Setting it to `true` allows local test orders to queue notifications without sending; never use this as a production delivery solution.

The adapter receives `Authorization: Bearer <token>`, `Idempotency-Key: order-<uuid>`, and JSON containing `type` (`order-confirmation` or `order-cancelled`), `order_id`, `email`, `total_cents`, `pickup_address`, `status`, and receipt `lines`. It must render a transactional email with the order reference, item details, amount payable at pickup, pickup address, and a separate timing notice for sweatshirt preorders. Escape customer/content values if rendering HTML. Return 2xx only after the provider accepts delivery. Deduplicate the idempotency key durably: delivery is at least once because a sender may crash after the provider accepts a message.

The same checkout function has a private dispatch path: a **POST with `Authorization: Bearer <EMAIL_DISPATCH_SECRET>`** runs the worker (no browser origin required). Configure a scheduler such as Supabase Cron to call it once per minute. Store the URL and bearer token in scheduler secrets/Vault, not in tracked SQL. Use `Content-Type: application/json` and body `{}`. This reuses the existing function; there is no second public checkout or email endpoint.

Each worker claims up to 10 messages with `FOR UPDATE SKIP LOCKED`, a unique lease token, and a 5-minute lease. Failures back off up to one hour, with 8 attempts before manual review. Immediate dispatch is best effort; the scheduler is required for reliable recovery. Set a scheduler timeout of at least 120 seconds. Monitor unsent messages and Edge Function errors. `supabase/operations.sql` includes failed-delivery inspection and retry examples.

The email worker's order payload also contains the customer's full name, phone number, Zelle payer name, optional payment reference, selected pickup option, and private `payment_proof_path`. The proof file itself is not included or made public.

Customers submit payment through Zelle before placing the order. Email wording should confirm receipt of the order and submission of payment proof, not claim that payment has been verified; sweatshirt distribution timing is based on order volume and will be sent to the provided email.

## Inventory and fulfillment

The cap has a $14.99 early-bird offer through **October 29, 2026, Pacific time**, then returns to $19.99. Its exclusive cutoff is Unix epoch **1793343600 seconds** (October 30 at 00:00 PDT / 07:00 UTC). The browser updates the price, total, and badge at that boundary and when a tab regains focus. Checkout uses PostgreSQL's [wall-clock timestamp](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT) after inventory locks are acquired; it never trusts a timestamp from the customer. A stale quote is rejected with `PRICE_CHANGED`. Committed orders retain their original totals on retries. This deadline applies to the cap; sweatshirt preorders remain $29.99.

Existing databases need a generated migration for the new `products.early_bird_price_cents` / `early_bird_ends_at_epoch` columns and updated `place_order` function, then the cap promotion update in `supabase/seed.sql`. The live project has not been updated from this workspace. Keep the normal cap `price_cents` at 1999; the promotion fields contain 1499 and 1793343600. The browser uses live promotion metadata once connected, so deploying the database change is required to activate the offer on a connected shop.

Use Supabase's dashboard for stock and order inspection. Finite stock starts at 200/200/100/100/200 for stickers 1–5, 50 caps, and 20/40 keychains. Caps cost $19.99; keychains cost $1.99. Sweatshirts cost $29.99 in XS, S, M, L, XL, XXL. Their pickup timing is explicitly unconfirmed.

- Edit stock and active prices in `products`. The frontend loads them fresh on page load and after checkout. Product imagery and descriptions are in `src/data/catalog.ts`; adding a new product requires both a catalog entry and a database row.
- Use `select public.cancel_order('ORDER-UUID'::uuid)` in the SQL editor to cancel and restock exactly once. **Do not set status to cancelled through the table editor**, which would bypass restocking.
- Mark placed orders collected using the example in `supabase/operations.sql`. Collected orders cannot be cancelled by the helper.
- Avoid changing a product's finite-stock/preorder model after accepting orders. There is no automatic expiry or customer cancellation page.
- The basic rate limiter allows 10 attempts per email per 10 minutes; it does not verify email ownership or stop someone rotating addresses. Delete old buckets periodically using the maintenance query. This is an intentionally account-free flow.

## Images

Brand assets live in `public/images/brand/`: `aims-logo.webp` and `ischool-logo.webp`, displayed as AIMS | iSchool in the header and footer. Both were converted losslessly and their PNG originals discarded as requested. The AIMS logo has `0.5em` rounded corners. Interface icons use tree-shaken Lucide imports; static page icons are rendered as SVG without client hydration.

Originals and the PDF remain in `AIMS Inventory/`. Website assets are renamed WebPs in `public/images/products/`; `src/data/assets.json` records their exact sources, dimensions, and sizes. **PDF Sticker 3 maps to source `05`; PDF Sticker 5 maps to source `03`.**

```sh
npm run assets
```

Uses lossless WebP for artwork, quality 82 for photos/mockups, preserves real transparency and aspect ratios, and never upscales. Primary files have a maximum 1200px edge; 400/800px variants are generated when the original is large enough. Fifteen primary images total about 1.23 MB versus 12.36 MB of originals. Responsive `srcset`, dimensions, and lazy loading are included.

## Verify and deploy

```sh
npm test
npm run check
npm run build
```

The unit suite verifies request validation, origin restrictions, database error handling, uncertain retries, rate limiting, email failure behavior, and asset fidelity. It mocks the database; it does **not** prove database transaction correctness.

For actual PostgreSQL concurrency and RLS verification, provision a **disposable** Supabase project with schema and seed applied, set `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_SUPABASE_PUBLISHABLE_KEY`, and `AIMS_DISPOSABLE_TEST_PROJECT=yes` in your shell, then run:

```sh
npm run test:database
```

These tests mutate shop settings and create temporary orders/products. They test concurrent last-unit orders, identical-key retries, all-or-nothing stock checks, bundles, preorder sizes, cancellation, price changes, public access restrictions, rate-limit concurrency, and email leases. They skip explicitly without test credentials. Never run them against the live shop.

For browser checks, install Playwright's Chromium (`npx playwright install chromium`) or set `CHROME_PATH` to your installed Chrome executable, then:

```sh
npm run test:browser
```

This starts a test server with mocked Supabase responses and verifies shopping, packs, size selection, totals, retry after reload, and mobile overflow. Desktop/mobile screenshots go to ignored `test-results/`.

Deploy `dist/` to a static host, with the two public Supabase variables available at build time. Set the function's allowed origin to the final HTTPS origin. This repository does not deploy or create a Supabase project automatically. Before opening orders, configure the pickup address, email adapter and scheduler; run the database/browser suites; and place one end-to-end test order through the deployed site.

Implementation verification in the development sandbox: unit/asset tests, TypeScript checks and production build can run. Network restrictions, blocked listening ports/Chrome launch, and missing Supabase project credentials prevent live database tests, browser QA and deployment here.
#   A I M S - 2 0 2 6 - W e b s t o r e  
 