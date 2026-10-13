# Email confirmations

This guide explains how to send AIMS order confirmations from an existing Google Workspace mailbox, or through a transactional email provider using your own domain.

**Current status:** the repository contains the order transaction, email outbox, and retry worker. It does **not** yet contain a Gmail/Resend sending adapter, OAuth setup helper, or configured scheduler. Adding credentials alone will not enable delivery; the sending adapter must be implemented and deployed first.

## Choose how to send

| Your situation | Suggested route | What you need |
| --- | --- | --- |
| Send through your actual Gmail/Google Workspace mailbox | Gmail API | Mailbox authorization, Google Cloud project, and any required organization approval |
| Send using an address on a domain you control | Resend or a similar transactional provider | Provider account, API key, and access to verify the domain through DNS |
| Organization-managed address, such as a university account | Confirm the provider and permissions with IT first | Approval to automate mail from that mailbox; an email address alone does not grant domain control |

Google Workspace is an assumption here. If your mailbox is hosted by Microsoft 365, Gmail instructions do not apply.

Customers enter their email and checkout details; they do not sign in to Google or authorize anything. Only the shop's sending account needs authorization.

## Option A: send through your Google Workspace mailbox

### 1. Set up Google authorization

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Gmail API**.
3. Configure the OAuth consent screen. Use an Internal audience if your organization makes it available and it fits this application; otherwise configure External access appropriately.
4. Create an OAuth client for a **Web application**. Register the exact callback URL of the authorization helper your developer sets up. That helper is not included in this repository yet.
5. Sign in as the intended sender and authorize offline access. The authorization request must use `access_type=offline`; the helper must validate OAuth `state` and exchange the returned code server-side.
6. Retain the client ID, client secret, and refresh token securely. Refresh tokens let the backend obtain access tokens without prompting the sender for every order.

Use Google's [server-side OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) for the authorization helper and token exchange.

Request only `https://www.googleapis.com/auth/gmail.send`. This scope permits sending without reading or modifying the inbox. Google classifies it as sensitive; verification requirements depend on your application's audience and usage. An organization may also restrict access. See [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

**Do not leave a production sender relying on External/Testing credentials.** Refresh tokens for an External app in Testing generally expire after seven days when using Gmail scopes. Tokens can also be revoked or expire for other reasons, so handle `invalid_grant` by reconnecting the sender. See [Google token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

### 2. Configure the sending adapter

The adapter needs these values; these are **proposed adapter settings**, not variables currently consumed by `checkout`:

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
EMAIL_FROM=Your Name <you@your-domain.example>
EMAIL_REPLY_TO=you@your-domain.example
```

Use the authorized mailbox as the sender. If you want an alias, configure and verify it with Google first. Do not use an unrelated address as `From`.

The adapter obtains an access token, constructs a MIME email, base64url-encodes it, and calls:

```text
POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
Authorization: Bearer <access-token>
Content-Type: application/json

{"raw":"<base64url-encoded-MIME-message>"}
```

Return success to the queue worker only after Google accepts the request. Store the returned message ID for troubleshooting. Google's [sending guide](https://developers.google.com/workspace/gmail/api/guides/sending) describes the format and API calls.

Keep these credentials in the adapter's server-side secret store. If it is another Supabase Edge Function, use [Supabase function secrets](https://supabase.com/docs/guides/functions/secrets). Never put credentials in frontend `PUBLIC_` variables, tracked files, or customer requests.

### SMTP alternative

Google also supports authenticated SMTP for apps using an app password where account policy allows it. This requires 2-Step Verification, and app passwords may be unavailable for an organization-managed account. It is an alternative integration, not something the current HTTP worker already implements. See [Google's app sending instructions](https://support.google.com/a/answer/176600) and [app passwords](https://support.google.com/accounts/answer/185833). Do not use your normal Google password in application code.

## Option B: use Resend with your domain

1. Create a Resend account and add a domain you control.
2. Add the DNS records Resend supplies and complete sending-domain verification. Preserve your existing Google Workspace inbound-mail configuration; do not replace its MX records to set up sending.
3. Create a sending API key and store it only in your backend.
4. Implement the adapter to translate this application's order payload into Resend's `from`, `to`, `subject`, `html`/`text`, and `reply_to` fields. Set replies to your Workspace address.

This sends through Resend, not through your Gmail mailbox. You cannot verify an organization-owned domain merely because you have an email address on it. Follow [Resend's domain setup](https://resend.com/docs/dashboard/domains/introduction) and [send-email API reference](https://resend.com/docs/api-reference/emails/send-email).

## Connect the adapter to this repository

The existing worker is in [checkout/index.ts](supabase/functions/checkout/index.ts). Configure its server-side secrets using [the example file](supabase/.env.functions.example):

| Setting | Meaning |
| --- | --- |
| `EMAIL_WEBHOOK_URL` | HTTPS URL of your deployed sending adapter; **not** Gmail's or Resend's raw API endpoint |
| `EMAIL_WEBHOOK_TOKEN` | Secret bearer token the adapter validates |
| `EMAIL_DISPATCH_SECRET` | Separate random bearer token for scheduled queue dispatch |
| `ALLOW_EMAIL_QUEUE_ONLY` | `false` for production; `true` permits local test orders without sending |
| `ALLOWED_ORIGIN` | Exact frontend origin, such as `https://shop.example.com`, without a trailing slash |

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the hosted function. The service key stays on the server.

The adapter receives:

```http
POST /your-email-adapter
Authorization: Bearer <EMAIL_WEBHOOK_TOKEN>
Idempotency-Key: order-<order-uuid>
Content-Type: application/json
```

Example body:

```json
{
  "type": "order-confirmation",
  "order_id": "00000000-0000-4000-8000-000000000001",
  "email": "customer@example.com",
  "total_cents": 1499,
  "pickup_address": "Your designated pickup address",
  "status": "placed",
  "lines": [
    { "name": "Cap", "size": "", "quantity": 1, "total_cents": 1499, "preorder": false }
  ]
}
```

Bundles include an `items` array containing sticker product IDs and quantities. Translate these IDs to readable names in the email.

The actual worker payload also includes `full_name`, `phone_number`, `zelle_payer_name`, `payment_reference`, `pickup_option`, and the private `payment_proof_path`. The proof image itself is not attached to the webhook or exposed through a public URL. Keep this personal and payment-related information within the shop's authorized email workflow.

The adapter must authenticate the bearer token, validate the payload, escape dynamic HTML, send the email, and return 2xx only after provider acceptance. Keep a durable record of idempotency keys and provider message IDs. For ambiguous timeouts after submission, reconcile before resending where possible; a queue and local deduplication alone cannot guarantee exactly-once email delivery.

If an unsent order has already been cancelled when the worker reads it, the payload type is `order-cancelled`. Handle that state explicitly. **There is no separate cancellation notification queued after an already-sent confirmation in the current implementation.**

An alternative implementation could call the chosen provider directly from the existing worker, avoiding an adapter endpoint. That requires changing the worker and its configuration checks; simply setting the current webhook URL to a provider API will not work.

## Schedule retries

Configure a server-side scheduler, such as Supabase Cron, to make this request once per minute:

```http
POST https://YOUR-PROJECT.supabase.co/functions/v1/checkout
Authorization: Bearer <EMAIL_DISPATCH_SECRET>
Content-Type: application/json

{}
```

Store the secret in the scheduler's secret store or Supabase Vault. The dispatcher needs no browser origin. Function JWT verification is disabled in [config.toml](supabase/config.toml); the dispatch branch authenticates the separate secret itself.

The worker claims up to 10 messages, with a five-minute lease and eight delivery attempts. Retry delays increase up to one hour. Use a scheduler HTTP timeout of at least 120 seconds. Checkout attempts an immediate send in the background, but the scheduler is needed to recover after process exits or delivery failures.

Inspect `email_outbox.attempts`, `last_error`, `next_attempt_at`, and `sent_at` in Supabase. Here, `sent_at` means the adapter reported provider acceptance; it does not prove inbox delivery. See [operations.sql](supabase/operations.sql) for failure inspection and retry queries. Provider bounce/delivery events are not integrated yet.

## Confirmation content

Suggested subject: **Your AIMS pickup order is confirmed — [reference]**

Include the order reference, item names, selected sizes, quantities, total, and chosen pickup location. Do not describe the order as paid solely because a screenshot was submitted; verify payment according to the shop's process. For sweatshirt preorders, explain that distribution timing depends on order volume and will be communicated to the email provided. Include a reply address customers can contact.

Use the saved order total, not current catalog prices: discounts may expire between ordering and sending.

## Verify before opening orders

1. Connect a test sender and send to an inbox you control. Confirm the sender, reply address, item details, amount, and pickup instructions.
2. Place a test order and verify both the order record and outbox record exist. Confirm provider acceptance updates `sent_at`.
3. Simulate a provider failure. The order must remain saved, inventory must stay deducted once, and the notification must remain retryable.
4. Restore delivery and run scheduled dispatch. Confirm retry handling and investigate ambiguous sends before manually resending.
5. Verify expired Google authorization or an invalid provider key produces an actionable failure rather than a false success.
6. Set `ALLOW_EMAIL_QUEUE_ONLY=false`, confirm the two pickup choices and distribution notice, and only then open ordering in `shop_settings`.

The existing tests cover the worker with a mocked adapter. They do not connect to Google or any email provider. No email has been sent or external account configured by adding this document.
