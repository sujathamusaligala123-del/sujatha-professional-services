# Secure eBook Delivery Setup

This project is the static Sujatha Professional Services website plus one Vercel Function that handles paid eBook delivery.

Production project: `sujatha5/sujatha-professional-services`
Production domain: `https://www.sujathaprofessionalservices.com`
Product: The AI Agent & Automation Income Blueprint
Price: ₹199 INR (`19900` paise)

## How it works

1. The Buy button loads Razorpay Standard Checkout.
2. `POST /api/create-order` creates a ₹199 INR order on the server and stores it in Supabase.
3. Razorpay returns `razorpay_order_id`, `razorpay_payment_id`, and `razorpay_signature`.
4. `POST /api/verify-payment` verifies the signature, fetches the payment from Razorpay, checks order/amount/currency/status, captures authorized payments if needed, and marks the purchase paid.
5. A signed HttpOnly cookie is issued. A short-lived pending cookie supports recovery if the browser closes before the success callback.
6. `GET /api/download` checks the signed cookie against a paid Supabase row, then streams the private PDF. There is no public PDF URL.
7. `POST /api/webhook/razorpay` verifies the raw-body HMAC and idempotently handles captured, authorized, failed, order-paid, and refunded events.

The PDF is never in Git, `public/`, or a public bucket. `.gitignore` ignores PDFs.

## One-time Supabase setup

If the project already has a suitable Supabase project, reuse it. Otherwise create a free Supabase project in the Supabase dashboard.

### Option A: Apply the migration with the provided script

Create a Supabase personal access token (Account → Access Tokens), then run locally:

```powershell
$env:SUPABASE_ACCESS_TOKEN="..."
$env:SUPABASE_PROJECT_REF="your-project-ref"
node scripts/apply-supabase-migration.mjs
```

The script applies `supabase/ebook-delivery.sql` and verifies the table and private bucket. It is safe to rerun.

### Option B: Apply the SQL manually

Open the Supabase SQL editor and paste the complete contents of `supabase/ebook-delivery.sql`. The SQL is idempotent.

It creates:

- `public.ebook_purchases` with unique Razorpay order/payment IDs
- Row Level Security with no anon/authenticated policies
- Service-role-only table grants
- A private `ebooks` storage bucket
- A restrictive storage policy that denies anon/authenticated access to the bucket

## One-time PDF upload

Set the server-only Supabase values locally and run:

```powershell
$env:SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="..."
node scripts/upload-ebook.mjs "C:\Users\Dell\Documents\SPS-Private-Assets\ai-agent-automation-income-blueprint.pdf"
```

The script uploads to `ebooks/ai-agent-automation-income-blueprint.pdf`, downloads it again, compares SHA-256, and fails if the file does not match. The original PDF is left untouched.

Current source PDF SHA-256:
`90E1C353688F149C9BEA91A224852E9F438A0C0A9778F102E1D31DC80310CB90`

## Vercel environment variables

Add these to the `sujatha-professional-services` project for **Production** and **Preview**:

| Name | Value / source |
|---|---|
| `RAZORPAY_KEY_ID` | Razorpay dashboard → API Keys |
| `RAZORPAY_KEY_SECRET` | Razorpay dashboard → API Keys (server-only) |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay dashboard → Webhooks (server-only) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server-only) |
| `EBOOK_DOWNLOAD_SECRET` | Random 32+ byte secret |
| `SITE_URL` | `https://www.sujathaprofessionalservices.com` |
| `EBOOK_PRICE_PAISE` | `19900` |
| `EBOOK_CURRENCY` | `INR` |
| `EBOOK_STORAGE_BUCKET` | `ebooks` |
| `EBOOK_STORAGE_PATH` | `ai-agent-automation-income-blueprint.pdf` |
| `EBOOK_FILE_NAME` | `AI-Agent-Automation-Income-Blueprint.pdf` |

Never add `NEXT_PUBLIC_` to any of these. Never put the service-role key or Razorpay secret in browser code.

## Razorpay webhook

In Razorpay dashboard → Settings → Webhooks, add:

`https://www.sujathaprofessionalservices.com/api/webhook/razorpay`

Enable:

- `payment.authorized`
- `payment.captured`
- `payment.failed`
- `order.paid`
- `refund.processed`

Copy the generated webhook secret into `RAZORPAY_WEBHOOK_SECRET` in Vercel.

## Deploy and test

1. Deploy the code.
2. Use Razorpay **test mode** first.
3. Pay ₹199 with a Razorpay test payment method.
4. Confirm the success panel and download button appear.
5. Confirm the downloaded file opens as a PDF.
6. Open `/api/download` in a private window with no cookie: it must be rejected.
7. Send the same webhook twice: the purchase must remain paid once.
8. Refund the test payment: download access must be revoked.
9. Only after the test flow passes, switch to live Razorpay keys and deactivate the old Payment Link `https://rzp.io/rzp/P7gMlHpx`.

Do not deactivate the old Payment Link before the replacement is deployed and verified.

## Recovery and edge cases

- Browser closes after payment: the webhook records the purchase; the signed pending cookie can restore access when the customer returns.
- Webhook arrives before the browser callback: the pending cookie checks the paid database row and issues download access.
- Duplicate webhook/callback: unique order/payment constraints and conditional updates prevent duplicate access.
- Refreshing the success page: `/api/access` restores the download button from the signed cookie.
- Pending/failed payment: no access is granted.
- Refund: `refund.processed` marks the purchase refunded and download access is denied.
- Expired download cookie: the customer can contact support; the purchase remains recorded in Supabase.
- Download path: fixed by server environment; request input cannot choose a storage path.

## Tests

Run the committed tests locally:

```powershell
node --test tests/ebook.integration.test.mjs tests/site-regression.test.mjs
```

These use mocked Razorpay and Supabase responses. They do not make real payments, upload files, or change production data.

## Remaining account-level actions

These cannot be done from the repository without credentials:

1. Create or choose the Supabase project and provide its URL/service-role key (or a Supabase access token for the migration script).
2. Provide Razorpay live/test API keys and create the webhook.
3. Add the environment variables in Vercel.
4. Run the migration and PDF upload, then deploy.
