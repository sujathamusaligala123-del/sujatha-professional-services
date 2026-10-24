import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { test } from "node:test";

const PRICE = 19900;
const KEY_SECRET = "test_key_secret_1234567890";
const WEBHOOK_SECRET = "test_webhook_secret_1234567890";
const DOWNLOAD_SECRET = "test_download_secret_not_real_1234567890";
const PDF = Buffer.from("%PDF-1.4\nmock ebook\n%%EOF\n", "utf8");

process.env.RAZORPAY_KEY_ID = "rzp_test_mock1234";
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test_service_role_key_not_real_123456789012345";
process.env.EBOOK_DOWNLOAD_SECRET = DOWNLOAD_SECRET;
process.env.EBOOK_PRICE_PAISE = String(PRICE);
process.env.EBOOK_CURRENCY = "INR";
process.env.SITE_URL = "http://127.0.0.1:3000";
process.env.EBOOK_STORAGE_BUCKET = "ebooks";
process.env.EBOOK_STORAGE_PATH = "ai-agent-automation-income-blueprint.pdf";
process.env.EBOOK_FILE_NAME = "AI-Agent-Automation-Income-Blueprint.pdf";

const orders = new Map();
const payments = new Map();
const rows = new Map();
let orderSeq = 0;

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function existingRow(orderId) {
  return rows.get(orderId) || null;
}

function matchRows(params) {
  const orderFilter = params.get("razorpay_order_id");
  const paymentFilter = params.get("razorpay_payment_id");
  const statusFilter = params.get("status");
  return [...rows.values()].filter((row) => {
    if (orderFilter && orderFilter.startsWith("eq.") && row.razorpay_order_id !== orderFilter.slice(3)) return false;
    if (paymentFilter && paymentFilter.startsWith("eq.") && row.razorpay_payment_id !== paymentFilter.slice(3)) return false;
    if (statusFilter === "eq.paid" && row.status !== "paid") return false;
    if (statusFilter === "not.in.(paid,refunded)" && (row.status === "paid" || row.status === "refunded")) return false;
    if (statusFilter === "eq.created" && row.status !== "created") return false;
    return true;
  });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = String(init.method || "GET").toUpperCase();

  if (url.hostname === "api.razorpay.com") {
    if (url.pathname === "/v1/orders" && method === "POST") {
      const body = JSON.parse(init.body);
      orderSeq += 1;
      const order = {
        id: `order_MOCK${String(orderSeq).padStart(10, "0")}`,
        amount: body.amount,
        currency: body.currency,
        receipt: body.receipt,
        notes: body.notes,
        status: "created",
      };
      orders.set(order.id, order);
      return jsonResponse(order);
    }

    const orderMatch = url.pathname.match(/^\/v1\/orders\/(order_[A-Za-z0-9]+)$/);
    if (orderMatch && method === "GET") {
      const order = orders.get(orderMatch[1]);
      return order ? jsonResponse(order) : jsonResponse({ error: { description: "not found" } }, 404);
    }

    const orderPaymentsMatch = url.pathname.match(/^\/v1\/orders\/(order_[A-Za-z0-9]+)\/payments$/);
    if (orderPaymentsMatch && method === "GET") {
      return jsonResponse({ items: [...payments.values()].filter((p) => p.order_id === orderPaymentsMatch[1]) });
    }

    const paymentMatch = url.pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)$/);
    if (paymentMatch && method === "GET") {
      const payment = payments.get(paymentMatch[1]);
      return payment ? jsonResponse(payment) : jsonResponse({ error: { description: "not found" } }, 404);
    }

    const captureMatch = url.pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/capture$/);
    if (captureMatch && method === "POST") {
      const payment = payments.get(captureMatch[1]);
      if (!payment) return jsonResponse({ error: { description: "not found" } }, 404);
      payment.status = "captured";
      payment.captured = true;
      return jsonResponse(payment);
    }

    return jsonResponse({ error: { description: `unexpected razorpay ${method} ${url.pathname}` } }, 500);
  }

  if (url.hostname === "test.supabase.co" && url.pathname.startsWith("/rest/v1/ebook_purchases")) {
    const params = url.searchParams;

    if (method === "GET") {
      return jsonResponse(matchRows(params));
    }

    if (method === "POST") {
      const inserted = JSON.parse(init.body);
      const item = Array.isArray(inserted) ? inserted[0] : inserted;
      if (rows.has(item.razorpay_order_id)) {
        return jsonResponse({ message: "duplicate key" }, 409);
      }
      const row = {
        id: crypto.randomUUID(),
        ...item,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      rows.set(row.razorpay_order_id, row);
      return jsonResponse([row], 201);
    }

    if (method === "PATCH") {
      const matched = matchRows(params);
      const patch = JSON.parse(init.body);
      for (const row of matched) Object.assign(row, patch);
      const prefer = String(init.headers?.Prefer || "");
      if (prefer.includes("return=representation")) return jsonResponse(matched);
      return new Response(null, { status: 204 });
    }

    return jsonResponse({ message: "unexpected supabase method" }, 500);
  }

  if (url.hostname === "test.supabase.co" && url.pathname.startsWith("/storage/v1/object/ebooks/")) {
    if (method === "GET") {
      if (url.pathname.startsWith("/storage/v1/object/ebooks/ebooks/")) {
        return jsonResponse({ message: "not found" }, 404);
      }
      return new Response(PDF, {
        status: 200,
        headers: { "Content-Type": "application/pdf", "Content-Length": String(PDF.length) },
      });
    }
    return jsonResponse({ message: "unexpected storage method" }, 500);
  }

  return originalFetch(input, init);
};

function signCheckout(orderId, paymentId) {
  return crypto.createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
}

function signWebhook(raw) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
}

function cookieValue(headers, name) {
  const list = headers["set-cookie"] || [];
  for (const entry of list) {
    const pair = entry.split(";")[0];
    const index = pair.indexOf("=");
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1);
  }
  return null;
}

function combinedCookies(headers) {
  return (headers["set-cookie"] || []).map((entry) => entry.split(";")[0]).join("; ");
}

function request(port, path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload ? { "Content-Length": String(payload.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("secure eBook purchase and delivery", async (t) => {
const moduleUrl = new URL("../api/ebook.mjs", import.meta.url).href;
const { default: handler } = await import(moduleUrl);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  req.query = Object.fromEntries(url.searchParams.entries());
  try {
    await handler(req, res);
  } catch (error) {
    console.error("server handler crash", error);
    res.statusCode = 500;
    res.end("crash");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
process.env.SITE_URL = `http://127.0.0.1:${port}`;
const origin = `http://127.0.0.1:${port}`;
let passed = 0;

function ok(name) {
  passed += 1;
  t.diagnostic(`PASS ${passed}: ${name}`);
}

try {
  const createRes = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(createRes.status, 200, createRes.body.toString());
  const createBody = JSON.parse(createRes.body.toString());
  assert.equal(createBody.ok, true);
  assert.equal(createBody.amount, PRICE);
  assert.ok(createBody.orderId.startsWith("order_"));
  const pendingCookie = cookieValue(createRes.headers, "sps_ebook_pending");
  assert.ok(pendingCookie);
  ok("create-order returns Razorpay order and sets signed pending cookie");

  const orderId = createBody.orderId;
  const paymentId = "pay_MOCKPAYMENT0001";
  payments.set(paymentId, {
    id: paymentId,
    order_id: orderId,
    amount: PRICE,
    currency: "INR",
    status: "captured",
    captured: true,
    email: "buyer@example.com",
  });

  const badSigRes = await request(port, "/api/verify-payment", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: "0".repeat(64) }),
  });
  assert.equal(badSigRes.status, 400, badSigRes.body.toString());
  assert.equal(JSON.parse(badSigRes.body.toString()).code, "invalid_signature");
  ok("verify-payment rejects a forged checkout signature");

  const verifyRes = await request(port, "/api/verify-payment", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signCheckout(orderId, paymentId),
    }),
  });
  assert.equal(verifyRes.status, 200, verifyRes.body.toString());
  const verifyBody = JSON.parse(verifyRes.body.toString());
  assert.equal(verifyBody.ok, true);
  const accessCookie = cookieValue(verifyRes.headers, "sps_ebook_access");
  assert.ok(accessCookie);
  assert.equal(existingRow(orderId).status, "paid");
  ok("verify-payment checks payment with Razorpay and marks the purchase paid");

  const accessRes = await request(port, "/api/access", {
    headers: { Cookie: combinedCookies(verifyRes.headers) },
  });
  assert.equal(accessRes.status, 200);
  assert.equal(JSON.parse(accessRes.body.toString()).paid, true);
  ok("access endpoint restores paid status from the signed cookie");

  const downloadRes = await request(port, "/api/download", {
    headers: { Cookie: combinedCookies(verifyRes.headers) },
  });
  assert.equal(downloadRes.status, 200, downloadRes.body.toString());
  assert.equal(downloadRes.headers["content-type"], "application/pdf");
  assert.equal(downloadRes.body.subarray(0, 5).toString(), "%PDF-");
  assert.ok(String(downloadRes.headers["content-disposition"]).includes("attachment"));
  ok("paid customer downloads the private PDF");

  const originalStoragePath = process.env.EBOOK_STORAGE_PATH;
  process.env.EBOOK_STORAGE_PATH = "ebooks/ai-agent-automation-income-blueprint.pdf";
  try {
    const fallbackDownload = await request(port, "/api/download", {
      headers: { Cookie: combinedCookies(verifyRes.headers) },
    });
    assert.equal(fallbackDownload.status, 200, fallbackDownload.body.toString());
    assert.equal(fallbackDownload.body.subarray(0, 5).toString(), "%PDF-");
    ok("download recovers when EBOOK_STORAGE_PATH repeats the bucket name");
  } finally {
    process.env.EBOOK_STORAGE_PATH = originalStoragePath;
  }

  const noCookieDownload = await request(port, "/api/download");
  assert.equal(noCookieDownload.status, 401);
  ok("download without a purchase cookie is rejected");

  const forged = `${accessCookie.split(".")[0]}.${"a".repeat(43)}`;
  const forgedDownload = await request(port, "/api/download", {
    headers: { Cookie: `sps_ebook_access=${forged}` },
  });
  assert.equal(forgedDownload.status, 401);
  ok("download with a forged access cookie is rejected");

  const webhookRaw = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: payments.get(paymentId) } },
  });
  const webhookRes = await request(port, "/api/webhook/razorpay", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": signWebhook(webhookRaw) },
    body: webhookRaw,
  });
  assert.equal(webhookRes.status, 200, webhookRes.body.toString());
  const webhookAgain = await request(port, "/api/webhook/razorpay", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": signWebhook(webhookRaw) },
    body: webhookRaw,
  });
  assert.equal(webhookAgain.status, 200);
  assert.equal(existingRow(orderId).status, "paid");
  ok("webhook verifies HMAC and is idempotent for duplicate payment.captured events");

  const forgedWebhook = await request(port, "/api/webhook/razorpay", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": "0".repeat(64) },
    body: webhookRaw,
  });
  assert.equal(forgedWebhook.status, 400);
  ok("webhook rejects an invalid HMAC signature");

  const create2 = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const secondOrderId = JSON.parse(create2.body.toString()).orderId;
  const secondPending = cookieValue(create2.headers, "sps_ebook_pending");
  const secondPaymentId = "pay_MOCKPAYMENT0002";
  payments.set(secondPaymentId, {
    id: secondPaymentId,
    order_id: secondOrderId,
    amount: PRICE,
    currency: "INR",
    status: "captured",
    captured: true,
  });
  const secondWebhookRaw = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: payments.get(secondPaymentId) } },
  });
  const secondWebhook = await request(port, "/api/webhook/razorpay", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": signWebhook(secondWebhookRaw) },
    body: secondWebhookRaw,
  });
  assert.equal(secondWebhook.status, 200);
  const secondAccess = await request(port, "/api/access", {
    headers: { Cookie: `sps_ebook_pending=${secondPending}` },
  });
  assert.equal(secondAccess.status, 200, secondAccess.body.toString());
  assert.equal(JSON.parse(secondAccess.body.toString()).paid, true);
  ok("webhook-first payment is recoverable from the signed pending cookie");

  const createReconciled = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const reconciledOrderId = JSON.parse(createReconciled.body.toString()).orderId;
  const reconciledPending = cookieValue(createReconciled.headers, "sps_ebook_pending");
  const reconciledPaymentId = "pay_MOCKRECONCILE01";
  payments.set(reconciledPaymentId, {
    id: reconciledPaymentId,
    order_id: reconciledOrderId,
    amount: PRICE,
    currency: "INR",
    status: "captured",
    captured: true,
    email: "reconciled@example.com",
  });
  const reconciledAccess = await request(port, "/api/access", {
    headers: { Cookie: `sps_ebook_pending=${reconciledPending}` },
  });
  assert.equal(reconciledAccess.status, 200, reconciledAccess.body.toString());
  assert.equal(JSON.parse(reconciledAccess.body.toString()).paid, true);
  assert.equal(existingRow(reconciledOrderId).status, "paid");
  assert.equal(existingRow(reconciledOrderId).razorpay_payment_id, reconciledPaymentId);
  ok("access reconciles a captured payment from Razorpay when callback and webhook are missing");

  const createMissingRow = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "x-forwarded-for": "198.51.100.20" },
    body: "{}",
  });
  assert.equal(createMissingRow.status, 200, createMissingRow.body.toString());
  const missingRowOrderId = JSON.parse(createMissingRow.body.toString()).orderId;
  const missingRowPending = cookieValue(createMissingRow.headers, "sps_ebook_pending");
  assert.ok(rows.delete(missingRowOrderId));
  const missingRowPaymentId = "pay_MOCKMISSINGROW1";
  payments.set(missingRowPaymentId, {
    id: missingRowPaymentId,
    order_id: missingRowOrderId,
    amount: PRICE,
    currency: "INR",
    status: "captured",
    captured: true,
    email: "lost-row@example.com",
  });
  const missingRowAccess = await request(port, "/api/access", {
    headers: { Cookie: `sps_ebook_pending=${missingRowPending}` },
  });
  assert.equal(missingRowAccess.status, 200, missingRowAccess.body.toString());
  const missingRowAccessBody = JSON.parse(missingRowAccess.body.toString());
  assert.equal(missingRowAccessBody.paid, true);
  assert.equal(missingRowAccessBody.downloadUrl, "/api/download");
  assert.equal(existingRow(missingRowOrderId).status, "paid");
  assert.equal(existingRow(missingRowOrderId).razorpay_order_id, missingRowOrderId);
  assert.equal(existingRow(missingRowOrderId).razorpay_payment_id, missingRowPaymentId);
  ok("access recreates a missing order row from a captured Razorpay payment");

  const missingRowDownload = await request(port, "/api/download", {
    headers: { Cookie: combinedCookies(missingRowAccess.headers) },
  });
  assert.equal(missingRowDownload.status, 200, missingRowDownload.body.toString());
  assert.equal(missingRowDownload.body.subarray(0, 5).toString(), "%PDF-");
  ok("a captured payment with a missing order row can download the private PDF");

  const missingRowAccessAgain = await request(port, "/api/access", {
    headers: { Cookie: `sps_ebook_pending=${missingRowPending}` },
  });
  assert.equal(JSON.parse(missingRowAccessAgain.body.toString()).paid, true);
  assert.equal(
    [...rows.values()].filter((row) => row.razorpay_order_id === missingRowOrderId).length,
    1,
  );
  ok("missing-order reconciliation is idempotent");

  const createMissingVerify = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "x-forwarded-for": "198.51.100.20" },
    body: "{}",
  });
  assert.equal(createMissingVerify.status, 200, createMissingVerify.body.toString());
  const missingVerifyOrderId = JSON.parse(createMissingVerify.body.toString()).orderId;
  assert.ok(rows.delete(missingVerifyOrderId));
  const missingVerifyPaymentId = "pay_MOCKMISSINGVERIFY1";
  payments.set(missingVerifyPaymentId, {
    id: missingVerifyPaymentId,
    order_id: missingVerifyOrderId,
    amount: PRICE,
    currency: "INR",
    status: "captured",
    captured: true,
  });
  const missingVerifyRes = await request(port, "/api/verify-payment", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: missingVerifyOrderId,
      razorpay_payment_id: missingVerifyPaymentId,
      razorpay_signature: signCheckout(missingVerifyOrderId, missingVerifyPaymentId),
    }),
  });
  assert.equal(missingVerifyRes.status, 200, missingVerifyRes.body.toString());
  assert.equal(existingRow(missingVerifyOrderId).status, "paid");
  assert.equal(existingRow(missingVerifyOrderId).razorpay_payment_id, missingVerifyPaymentId);
  ok("verify-payment recreates a missing order row using the verified order and payment");

  const createMissingUnpaid = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "x-forwarded-for": "198.51.100.20" },
    body: "{}",
  });
  assert.equal(createMissingUnpaid.status, 200, createMissingUnpaid.body.toString());
  const missingUnpaidOrderId = JSON.parse(createMissingUnpaid.body.toString()).orderId;
  const missingUnpaidPending = cookieValue(createMissingUnpaid.headers, "sps_ebook_pending");
  assert.ok(rows.delete(missingUnpaidOrderId));
  const missingUnpaidAccess = await request(port, "/api/access", {
    headers: { Cookie: `sps_ebook_pending=${missingUnpaidPending}` },
  });
  assert.equal(missingUnpaidAccess.status, 200);
  const missingUnpaidBody = JSON.parse(missingUnpaidAccess.body.toString());
  assert.equal(missingUnpaidBody.paid, false);
  assert.equal(missingUnpaidBody.pending, true);
  const missingUnpaidDownload = await request(port, "/api/download", {
    headers: { Cookie: `sps_ebook_pending=${missingUnpaidPending}` },
  });
  assert.equal(missingUnpaidDownload.status, 401);
  ok("a missing order row without a captured payment does not grant PDF access");

  const refundRaw = JSON.stringify({
    event: "refund.processed",
    payload: { refund: { entity: { payment_id: secondPaymentId, amount: PRICE } } },
  });
  const refundRes = await request(port, "/api/webhook/razorpay", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": signWebhook(refundRaw) },
    body: refundRaw,
  });
  assert.equal(refundRes.status, 200);
  assert.equal(existingRow(secondOrderId).status, "refunded");
  ok("full refund revokes the purchase");

  const refundedAccess = cookieValue(secondAccess.headers, "sps_ebook_access");
  const refundedDownload = await request(port, "/api/download", {
    headers: { Cookie: `sps_ebook_access=${refundedAccess}` },
  });
  assert.equal(refundedDownload.status, 401);
  ok("refunded purchase can no longer download the PDF");

  const create3 = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const thirdOrderId = JSON.parse(create3.body.toString()).orderId;
  const failedRaw = JSON.stringify({
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_MOCKFAILED0001", order_id: thirdOrderId, amount: PRICE, currency: "INR", status: "failed" } } },
  });
  const failedRes = await request(port, "/api/webhook/razorpay", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": signWebhook(failedRaw) },
    body: failedRaw,
  });
  assert.equal(failedRes.status, 200);
  assert.equal(existingRow(thirdOrderId).status, "failed");
  ok("failed payment is recorded without granting access");

  const duplicateVerify = await request(port, "/api/verify-payment", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signCheckout(orderId, paymentId),
    }),
  });
  assert.equal(duplicateVerify.status, 200, duplicateVerify.body.toString());
  ok("duplicate verify of the same successful payment is idempotent");

  const create4 = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const fourthOrderId = JSON.parse(create4.body.toString()).orderId;
  const fourthPaymentId = "pay_MOCKAUTHORIZED01";
  payments.set(fourthPaymentId, {
    id: fourthPaymentId,
    order_id: fourthOrderId,
    amount: PRICE,
    currency: "INR",
    status: "authorized",
    captured: false,
  });
  const authorizedVerify = await request(port, "/api/verify-payment", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: fourthOrderId,
      razorpay_payment_id: fourthPaymentId,
      razorpay_signature: signCheckout(fourthOrderId, fourthPaymentId),
    }),
  });
  assert.equal(authorizedVerify.status, 200, authorizedVerify.body.toString());
  assert.equal(payments.get(fourthPaymentId).status, "captured");
  assert.equal(existingRow(fourthOrderId).status, "paid");
  ok("authorized payment is captured server-side before access is granted");

  const create5 = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const fifthOrderId = JSON.parse(create5.body.toString()).orderId;
  const fifthPaymentId = "pay_MOCKLOWAMOUNT001";
  payments.set(fifthPaymentId, {
    id: fifthPaymentId,
    order_id: fifthOrderId,
    amount: 100,
    currency: "INR",
    status: "captured",
    captured: true,
  });
  const lowAmountVerify = await request(port, "/api/verify-payment", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: fifthOrderId,
      razorpay_payment_id: fifthPaymentId,
      razorpay_signature: signCheckout(fifthOrderId, fifthPaymentId),
    }),
  });
  assert.equal(lowAmountVerify.status, 409, lowAmountVerify.body.toString());
  assert.equal(existingRow(fifthOrderId).status, "created");
  ok("payment amount mismatch is rejected and does not grant access");

  const crossOriginCreate = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(crossOriginCreate.status, 403);
  ok("create-order rejects a cross-origin request");

  const createWebhookAuth = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  const webhookAuthOrderId = JSON.parse(createWebhookAuth.body.toString()).orderId;
  const webhookAuthPaymentId = "pay_MOCKAUTHWEBHOOK1";
  payments.set(webhookAuthPaymentId, {
    id: webhookAuthPaymentId,
    order_id: webhookAuthOrderId,
    amount: PRICE,
    currency: "INR",
    status: "authorized",
    captured: false,
  });
  const authorizedWebhookRaw = JSON.stringify({
    event: "payment.authorized",
    payload: { payment: { entity: payments.get(webhookAuthPaymentId) } },
  });
  const authorizedWebhook = await request(port, "/api/webhook/razorpay", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": signWebhook(authorizedWebhookRaw) },
    body: authorizedWebhookRaw,
  });
  assert.equal(authorizedWebhook.status, 200, authorizedWebhook.body.toString());
  assert.equal(payments.get(webhookAuthPaymentId).status, "captured");
  assert.equal(existingRow(webhookAuthOrderId).status, "paid");
  ok("payment.authorized webhook captures the payment and grants paid status");

  const createPending = await request(port, "/api/create-order", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(createPending.status, 200, createPending.body.toString());
  const pendingOnly = cookieValue(createPending.headers, "sps_ebook_pending");
  const pendingBeforePay = await request(port, "/api/access", {
    headers: { Cookie: `sps_ebook_pending=${pendingOnly}` },
  });
  assert.equal(pendingBeforePay.status, 200);
  assert.equal(JSON.parse(pendingBeforePay.body.toString()).paid, false);
  ok("unpaid pending order does not grant download access");

  t.diagnostic(`All ${passed} integration checks passed.`);
} finally {
  server.close();
  globalThis.fetch = originalFetch;
}
});
