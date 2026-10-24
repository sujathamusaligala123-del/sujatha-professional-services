import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function read(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("existing website content and navigation are preserved", async () => {
  const html = await read("index.html");

  for (const id of [
    "top",
    "main",
    "services",
    "financial",
    "nursing",
    "wellness",
    "why",
    "about",
    "ebook",
    "faq",
    "enquiry",
    "enquiry-form",
    "buy-ebook",
    "ebook-status",
    "year",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `Missing #${id}`);
  }

  for (const href of [
    "privacy-policy.html",
    "terms-and-conditions.html",
    "disclaimer.html",
    "data-deletion.html",
  ]) {
    assert.match(html, new RegExp(href), `Missing legal link ${href}`);
  }

  assert.match(html, /<script src="\/ebook\.js" defer><\/script>/);
});

test("eBook UI no longer uses the manual Razorpay payment link", async () => {
  const html = await read("index.html");
  const js = await read("ebook.js");

  assert.doesNotMatch(html, /rzp\.io\/rzp\/P7gMlHpx/);
  assert.doesNotMatch(html, /delivered manually/i);
  assert.doesNotMatch(html, /automatic download delivery is not set up/i);
  assert.match(html, /Buy eBook – ₹199/);
  assert.match(html, /Your download unlocks automatically after successful payment/);
  assert.match(js, /Download Your eBook/);
  assert.match(js, /\/api\/create-order/);
  assert.match(js, /\/api\/verify-payment/);
  assert.match(js, /\/api\/access/);
});

test("browser assets never contain server secrets", async () => {
  const browserAssets = `${await read("index.html")}\n${await read("ebook.js")}`;

  assert.doesNotMatch(browserAssets, /RAZORPAY_KEY_SECRET/);
  assert.doesNotMatch(browserAssets, /RAZORPAY_WEBHOOK_SECRET/);
  assert.doesNotMatch(browserAssets, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(browserAssets, /EBOOK_DOWNLOAD_SECRET/);
  assert.doesNotMatch(browserAssets, /service_role/);
  assert.doesNotMatch(browserAssets, /NEXT_PUBLIC_/);
});

test("API implements secure verification and delivery controls", async () => {
  const api = await read("api/ebook.mjs");

  assert.match(api, /timingSafeEqual/);
  assert.match(api, /RAZORPAY_WEBHOOK_SECRET/);
  assert.match(api, /x-razorpay-signature/);
  assert.match(api, /payment\.captured/);
  assert.match(api, /payment\.authorized/);
  assert.match(api, /payment\.failed/);
  assert.match(api, /order\.paid/);
  assert.match(api, /refund\.processed/);
  assert.match(api, /HttpOnly/);
  assert.match(api, /SameSite=Lax/);
  assert.match(api, /Path=\/api\//);
  assert.match(api, /status !== "captured"/);
  assert.match(api, /CFG\.pricePaise|pricePaise/);
  assert.match(api, /objectPath/);
  assert.doesNotMatch(api, /NEXT_PUBLIC_/);
});

test("Vercel routing and function configuration are present", async () => {
  const config = JSON.parse(await read("vercel.json"));

  assert.ok(config.functions["api/ebook.mjs"]);
  assert.equal(config.functions["api/ebook.mjs"].maxDuration, 30);
  assert.ok(
    config.rewrites.some(
      (rewrite) => rewrite.source === "/api/download" && rewrite.destination === "/api/ebook?action=download",
    ),
  );
  assert.ok(
    config.rewrites.some(
      (rewrite) =>
        rewrite.source === "/api/webhook/razorpay" &&
        rewrite.destination === "/api/ebook?action=webhook",
    ),
  );
  assert.ok(config.rewrites.some((rewrite) => rewrite.source === "/scripts/(.*)"));
  assert.ok(config.rewrites.some((rewrite) => rewrite.source === "/supabase/(.*)"));
});

test("environment template documents every required variable", async () => {
  const env = await read(".env.example");

  for (const name of [
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "EBOOK_DOWNLOAD_SECRET",
    "SITE_URL",
    "EBOOK_PRICE_PAISE",
    "EBOOK_CURRENCY",
    "EBOOK_STORAGE_BUCKET",
    "EBOOK_STORAGE_PATH",
    "EBOOK_FILE_NAME",
  ]) {
    assert.match(env, new RegExp(`^${name}=`, "m"), `Missing ${name}`);
  }

  assert.match(env, /^SITE_URL=https:\/\/www\.sujathaprofessionalservices\.com$/m);
  assert.match(env, /^EBOOK_PRICE_PAISE=19900$/m);
  assert.match(env, /^EBOOK_CURRENCY=INR$/m);
});

test("Supabase migration creates a private, server-only purchase store", async () => {
  const sql = await read("supabase/ebook-delivery.sql");

  assert.match(sql, /create table if not exists public\.ebook_purchases/);
  assert.match(sql, /razorpay_order_id text not null unique/);
  assert.match(sql, /razorpay_payment_id text unique/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.ebook_purchases from anon/);
  assert.match(sql, /revoke all on table public\.ebook_purchases from authenticated/);
  assert.match(sql, /grant all on table public\.ebook_purchases to service_role/);
  assert.match(sql, /values \('ebooks', 'ebooks', false/);
  assert.match(sql, /as restrictive/);
  assert.match(sql, /bucket_id <> 'ebooks'/);
});
