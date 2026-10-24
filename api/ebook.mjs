import crypto from "node:crypto";

export const config = { api: { bodyParser: false } };

const PRODUCT_ID = "ai-agent-automation-income-blueprint";
const PRODUCT_NAME = "The AI Agent & Automation Income Blueprint";
const DEFAULT_PRICE_PAISE = 19900;
const DEFAULT_CURRENCY = "INR";
const DEFAULT_BUCKET = "ebooks";
const DEFAULT_OBJECT_PATH = "ai-agent-automation-income-blueprint.pdf";
const DEFAULT_FILE_NAME = "AI-Agent-Automation-Income-Blueprint.pdf";

const ACCESS_COOKIE = "sps_ebook_access";
const PENDING_COOKIE = "sps_ebook_pending";
const ORDER_FIELDS =
  "product_id,razorpay_order_id,razorpay_payment_id,amount,currency,status,buyer_email,paid_at,created_at";

const MAX_JSON_BYTES = 16 * 1024;
const MAX_WEBHOOK_BYTES = 512 * 1024;

const ORDER_ID_RE = /^order_[A-Za-z0-9]{6,40}$/;
const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{6,40}$/;
const SIGNATURE_RE = /^[a-f0-9]{64}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

class HttpError extends Error {
  constructor(status, code, message, internalDetail) {
    super(internalDetail || message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

const rateLimits = new Map();

export default async function handler(req, res) {
  const action = getAction(req);
  try {
    if (action === "create-order") return await handleCreateOrder(req, res);
    if (action === "verify-payment") return await handleVerifyPayment(req, res);
    if (action === "access") return await handleAccess(req, res);
    if (action === "download") return await handleDownload(req, res);
    if (action === "webhook") return await handleWebhook(req, res);
    throw new HttpError(404, "not_found", "Not found.");
  } catch (error) {
    if (action === "download") return serveError(res, error, { plain: true });
    return serveError(res, error);
  }
}

function actionFromPath(pathname) {
  if (pathname === "/api/create-order") return "create-order";
  if (pathname === "/api/verify-payment") return "verify-payment";
  if (pathname === "/api/access") return "access";
  if (pathname === "/api/download") return "download";
  if (pathname === "/api/webhook/razorpay") return "webhook";
  return "";
}

function getAction(req) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const pathAction = actionFromPath(url.pathname);
    if (pathAction) return pathAction;
    let fromQuery = url.searchParams.get("action") || "";
    try {
      fromQuery = String(req.query?.action || fromQuery);
    } catch {
      // Fall back to the URL query string.
    }
    return String(fromQuery).trim();
  } catch {
    return "";
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(payload));
}

function serveError(res, error, { plain = false } = {}) {
  const isHttp = error instanceof HttpError;
  const status = isHttp ? error.status : 500;
  const code = isHttp ? error.code : "internal_error";
  const message = isHttp ? error.publicMessage : "Something went wrong. Please try again.";
  console.error(`[ebook] ${code}:`, error instanceof Error ? error.message : String(error));
  if (plain) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(`${message}\n`);
    return;
  }
  sendJson(res, status, { ok: false, code, message });
}

function requireMethod(req, method) {
  if (String(req.method || "").toUpperCase() !== method) {
    throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  }
}

async function readRawBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, "body_too_large", "Request is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const raw = await readRawBody(req, MAX_JSON_BYTES);
  if (raw.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid request body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json", "Invalid request body.");
  }
  return parsed;
}

function requireEnv(name, minLength = 1) {
  const value = String(process.env[name] || "").trim();
  if (!value || value.length < minLength) {
    throw new HttpError(
      500,
      "server_not_configured",
      "Secure checkout is not configured yet. Please contact support.",
      `Missing or invalid ${name}`,
    );
  }
  return value;
}

function parseIntegerSetting(name, fallback, min, max) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(
      500,
      "server_not_configured",
      "Secure checkout is not configured yet. Please contact support.",
      `Invalid ${name}`,
    );
  }
  return value;
}

function parseBucket(value) {
  const bucket = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(bucket) || bucket === "." || bucket === "..") {
    throw new HttpError(
      500,
      "server_not_configured",
      "Secure checkout is not configured yet. Please contact support.",
      "Invalid EBOOK_STORAGE_BUCKET",
    );
  }
  return bucket;
}

function parseObjectPath(value) {
  const objectPath = String(value || "").trim().replace(/\\/g, "/");
  if (
    !objectPath ||
    objectPath.startsWith("/") ||
    objectPath.endsWith("/") ||
    objectPath.includes("..") ||
    objectPath.includes("//") ||
    !/\.pdf$/i.test(objectPath)
  ) {
    throw new HttpError(
      500,
      "server_not_configured",
      "Secure checkout is not configured yet. Please contact support.",
      "Invalid EBOOK_STORAGE_PATH",
    );
  }
  const segments = objectPath.split("/");
  if (segments.length > 8 || segments.some((segment) => !/^[A-Za-z0-9._-]{1,128}$/.test(segment))) {
    throw new HttpError(
      500,
      "server_not_configured",
      "Secure checkout is not configured yet. Please contact support.",
      "Invalid EBOOK_STORAGE_PATH",
    );
  }
  return objectPath;
}

function parseFileName(value) {
  const name = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._ -]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > 120 || !/\.pdf$/i.test(name)) {
    throw new HttpError(
      500,
      "server_not_configured",
      "Secure checkout is not configured yet. Please contact support.",
      "Invalid EBOOK_FILE_NAME",
    );
  }
  return name;
}

function getConfig() {
  const pricePaise = parseIntegerSetting("EBOOK_PRICE_PAISE", DEFAULT_PRICE_PAISE, 100, 10_000_000);
  const currency = String(process.env.EBOOK_CURRENCY || DEFAULT_CURRENCY).trim().toUpperCase();
  if (currency !== "INR") {
    throw new HttpError(
      500,
      "server_not_configured",
      "Secure checkout is not configured yet. Please contact support.",
      "EBOOK_CURRENCY must be INR",
    );
  }

  const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  let parsedSupabaseUrl;
  try {
    parsedSupabaseUrl = new URL(supabaseUrl);
  } catch {
    throw new HttpError(
      500,
      "server_not_configured",
      "Secure checkout is not configured yet. Please contact support.",
      "Invalid SUPABASE_URL",
    );
  }
  if (parsedSupabaseUrl.protocol !== "https:") {
    throw new HttpError(
      500,
      "server_not_configured",
      "Secure checkout is not configured yet. Please contact support.",
      "SUPABASE_URL must use HTTPS",
    );
  }

  return {
    keyId: requireEnv("RAZORPAY_KEY_ID", 8),
    keySecret: requireEnv("RAZORPAY_KEY_SECRET", 16),
    webhookSecret: String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim(),
    supabaseUrl,
    supabaseKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY", 20),
    downloadSecret: requireEnv("EBOOK_DOWNLOAD_SECRET", 32),
    pricePaise,
    currency,
    bucket: parseBucket(process.env.EBOOK_STORAGE_BUCKET || DEFAULT_BUCKET),
    objectPath: parseObjectPath(process.env.EBOOK_STORAGE_PATH || DEFAULT_OBJECT_PATH),
    fileName: parseFileName(process.env.EBOOK_FILE_NAME || DEFAULT_FILE_NAME),
    accessDays: parseIntegerSetting("EBOOK_ACCESS_DAYS", 7, 1, 90),
    pendingDays: parseIntegerSetting("EBOOK_PENDING_DAYS", 7, 1, 90),
    siteUrl: String(process.env.SITE_URL || "https://www.sujathaprofessionalservices.com")
      .trim()
      .replace(/\/+$/, ""),
  };
}

function assertSameOrigin(req, cfg) {
  const origin = String(req.headers.origin || "").trim().replace(/\/+$/, "");
  if (!origin) return;

  const allowed = new Set();
  if (cfg.siteUrl) allowed.add(cfg.siteUrl);
  const host = String(req.headers.host || "").trim();
  if (host) {
    allowed.add(`https://${host}`);
    allowed.add(`http://${host}`);
  }
  allowed.add("https://sujathaprofessionalservices.com");
  allowed.add("https://www.sujathaprofessionalservices.com");
  allowed.add("https://sujathaprofessional.com");
  allowed.add("https://www.sujathaprofessional.com");
  allowed.add("https://sujatha-professional-services.vercel.app");

  for (const entry of String(process.env.ALLOWED_ORIGINS || "").split(",")) {
    const value = entry.trim().replace(/\/+$/, "");
    if (value) allowed.add(value);
  }

  if (!allowed.has(origin)) {
    throw new HttpError(403, "origin_not_allowed", "This request is not allowed.");
  }
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.socket?.remoteAddress || "unknown");
}

function assertRateLimit(req, key, limit, windowMs) {
  const now = Date.now();
  const id = `${key}:${clientIp(req)}`;
  const current = rateLimits.get(id);
  if (!current || current.resetAt <= now) {
    rateLimits.set(id, { count: 1, resetAt: now + windowMs });
    if (rateLimits.size > 5000) {
      for (const [entryKey, entry] of rateLimits) {
        if (entry.resetAt <= now) rateLimits.delete(entryKey);
      }
    }
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    throw new HttpError(429, "rate_limited", "Too many requests. Please wait a moment and try again.");
  }
}

async function razorpayRequest(cfg, path, { method = "GET", body } = {}) {
  const authorization = Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
  let response;
  try {
    response = await fetch(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Basic ${authorization}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw new HttpError(
      502,
      "payment_provider_unavailable",
      "The payment provider is temporarily unavailable. Please try again.",
      `Razorpay request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const description = data?.error?.description || `HTTP ${response.status}`;
    throw new HttpError(
      response.status >= 500 ? 502 : 400,
      "payment_provider_error",
      "The payment provider could not complete this request.",
      `Razorpay ${method} ${path}: ${description}`,
    );
  }

  return data;
}

function verifyCheckoutSignature(orderId, paymentId, signature, secret) {
  if (!SIGNATURE_RE.test(signature)) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest();
  const provided = Buffer.from(signature, "hex");
  return provided.length === expected.length && crypto.timingSafeEqual(expected, provided);
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signature, "hex");
  return provided.length === expected.length && crypto.timingSafeEqual(expected, provided);
}

function supabaseHeaders(cfg, extra = {}) {
  return {
    apikey: cfg.supabaseKey,
    Authorization: `Bearer ${cfg.supabaseKey}`,
    Accept: "application/json",
    ...extra,
  };
}

async function supabaseRequest(cfg, path, { method = "GET", body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(`${cfg.supabaseUrl}${path}`, {
      method,
      headers: supabaseHeaders(cfg, {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw new HttpError(
      503,
      "storage_unavailable",
      "Secure delivery is temporarily unavailable. Please try again in a minute.",
      `Supabase request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const detail = data?.message || data?.error || `HTTP ${response.status}`;
    throw new HttpError(
      response.status === 409 ? 409 : 503,
      "storage_error",
      "Secure delivery is temporarily unavailable. Please try again in a minute.",
      `Supabase ${method} ${path}: ${detail}`,
    );
  }

  return data;
}

function orderQuery(orderId) {
  return new URLSearchParams({
    select: ORDER_FIELDS,
    razorpay_order_id: `eq.${orderId}`,
    limit: "1",
  }).toString();
}

async function getOrderRow(cfg, orderId) {
  const rows = await supabaseRequest(cfg, `/rest/v1/ebook_purchases?${orderQuery(orderId)}`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getPaidRow(cfg, paymentId, orderId) {
  const query = new URLSearchParams({
    select: ORDER_FIELDS,
    razorpay_payment_id: `eq.${paymentId}`,
    razorpay_order_id: `eq.${orderId}`,
    status: "eq.paid",
    limit: "1",
  }).toString();
  const rows = await supabaseRequest(cfg, `/rest/v1/ebook_purchases?${query}`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getPaidRowByPaymentId(cfg, paymentId) {
  const query = new URLSearchParams({
    select: ORDER_FIELDS,
    razorpay_payment_id: `eq.${paymentId}`,
    status: "eq.paid",
    limit: "1",
  }).toString();
  const rows = await supabaseRequest(cfg, `/rest/v1/ebook_purchases?${query}`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function insertOrderRow(cfg, { orderId, amount, currency }) {
  const query = new URLSearchParams({ on_conflict: "razorpay_order_id" }).toString();
  try {
    await supabaseRequest(cfg, `/rest/v1/ebook_purchases?${query}`, {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates" },
      body: [
        {
          product_id: PRODUCT_ID,
          razorpay_order_id: orderId,
          amount,
          currency,
          status: "created",
        },
      ],
    });
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
  }
}

async function patchPaid(cfg, orderId, body) {
  const query = new URLSearchParams({
    razorpay_order_id: `eq.${orderId}`,
    status: "not.in.(paid,refunded)",
  }).toString();
  const rows = await supabaseRequest(cfg, `/rest/v1/ebook_purchases?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body,
  });
  return Array.isArray(rows) ? rows : [];
}

async function markFailed(cfg, orderId) {
  const query = new URLSearchParams({
    razorpay_order_id: `eq.${orderId}`,
    status: "eq.created",
  }).toString();
  await supabaseRequest(cfg, `/rest/v1/ebook_purchases?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: { status: "failed", updated_at: new Date().toISOString() },
  });
}

async function markRefunded(cfg, paymentId) {
  const query = new URLSearchParams({
    razorpay_payment_id: `eq.${paymentId}`,
    status: "eq.paid",
  }).toString();
  await supabaseRequest(cfg, `/rest/v1/ebook_purchases?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: { status: "refunded", updated_at: new Date().toISOString() },
  });
}

function assertOrderMatchesProduct(cfg, order) {
  if (!order || typeof order !== "object") {
    throw new HttpError(502, "invalid_order", "The payment provider returned an invalid order.");
  }
  if (Number(order.amount) !== cfg.pricePaise) {
    throw new HttpError(409, "amount_mismatch", "The order amount does not match the eBook price.");
  }
  if (String(order.currency || "").toUpperCase() !== cfg.currency) {
    throw new HttpError(409, "currency_mismatch", "The order currency does not match the eBook price.");
  }
  const notes = order.notes && typeof order.notes === "object" ? order.notes : {};
  const receipt = String(order.receipt || "");
  if (notes.product_id && notes.product_id !== PRODUCT_ID) {
    throw new HttpError(409, "unknown_product", "This order is not for the eBook.");
  }
  if (!notes.product_id && !receipt.startsWith("sps_ebook_")) {
    throw new HttpError(409, "unknown_product", "This order is not for the eBook.");
  }
}

function assertOrderRowMatchesProduct(row) {
  if (!row || row.product_id !== PRODUCT_ID) {
    throw new HttpError(409, "unknown_product", "This order is not for the eBook.");
  }
}

function assertPaymentMatchesOrder(payment, row) {
  if (!payment || typeof payment !== "object") {
    throw new HttpError(502, "invalid_payment", "The payment provider returned an invalid payment.");
  }
  if (payment.order_id !== row.razorpay_order_id) {
    throw new HttpError(409, "payment_order_mismatch", "This payment does not belong to the eBook order.");
  }
  if (Number(payment.amount) !== Number(row.amount)) {
    throw new HttpError(409, "amount_mismatch", "The paid amount does not match the eBook price.");
  }
  if (String(payment.currency || "").toUpperCase() !== String(row.currency || "").toUpperCase()) {
    throw new HttpError(409, "currency_mismatch", "The paid currency does not match the eBook price.");
  }
  if (payment.status === "refunded") {
    throw new HttpError(409, "payment_refunded", "This payment has been refunded.");
  }
}

async function ensureOrderRow(cfg, orderId, payment) {
  let row = await getOrderRow(cfg, orderId);
  if (row) {
    assertOrderRowMatchesProduct(row);
    return row;
  }

  const order = await razorpayRequest(cfg, `/orders/${encodeURIComponent(orderId)}`);
  assertOrderMatchesProduct(cfg, order);
  if (payment) {
    if (payment.order_id !== order.id) {
      throw new HttpError(409, "payment_order_mismatch", "This payment does not belong to the eBook order.");
    }
    if (Number(payment.amount) !== Number(order.amount)) {
      throw new HttpError(409, "amount_mismatch", "The paid amount does not match the eBook price.");
    }
  }
  await insertOrderRow(cfg, {
    orderId: order.id,
    amount: Number(order.amount),
    currency: String(order.currency || cfg.currency).toUpperCase(),
  });
  row = await getOrderRow(cfg, orderId);
  if (!row) {
    throw new HttpError(503, "storage_unavailable", "Secure delivery is temporarily unavailable. Please try again in a minute.");
  }
  assertOrderRowMatchesProduct(row);
  return row;
}

async function markPaid(cfg, { orderId, paymentId, signature, email }) {
  let row = await getOrderRow(cfg, orderId);
  if (!row) {
    row = await ensureOrderRow(cfg, orderId, null);
  }
  assertOrderRowMatchesProduct(row);

  if (row.status === "refunded") {
    throw new HttpError(409, "purchase_refunded", "This purchase has been refunded.");
  }
  if (row.status === "paid") {
    if (row.razorpay_payment_id === paymentId) return row;
    throw new HttpError(409, "order_already_paid", "This order is already linked to a different payment.");
  }

  const now = new Date().toISOString();
  const body = {
    status: "paid",
    razorpay_payment_id: paymentId,
    paid_at: now,
    updated_at: now,
  };
  if (signature) body.razorpay_signature = signature;
  if (email) body.buyer_email = email;

  const updated = await patchPaid(cfg, orderId, body);
  if (updated.length === 1) return updated[0];

  const current = await getOrderRow(cfg, orderId);
  if (current?.status === "paid" && current.razorpay_payment_id === paymentId) {
    return current;
  }
  throw new HttpError(409, "order_state_conflict", "The order could not be updated. Please contact support.");
}

async function listOrderPayments(cfg, orderId) {
  const data = await razorpayRequest(cfg, `/orders/${encodeURIComponent(orderId)}/payments`);
  return Array.isArray(data?.items) ? data.items : [];
}

async function reconcileOrderPayment(cfg, orderId) {
  let row = await getOrderRow(cfg, orderId);
  if (!row) row = await ensureOrderRow(cfg, orderId, null);
  assertOrderRowMatchesProduct(row);
  if (row.status === "paid" || row.status === "refunded") return row;

  const payments = await listOrderPayments(cfg, orderId);
  let payment = payments.find(
    (item) => item && item.status === "captured" && item.captured !== false,
  );

  if (!payment) {
    const authorized = payments.find((item) => item && item.status === "authorized");
    if (authorized) {
      const settled = await captureAuthorizedPayment(cfg, authorized.id, authorized);
      if (settled?.status === "captured" && settled.captured !== false) {
        payment = settled;
      }
    }
  }

  if (!payment) return row;

  assertPaymentMatchesOrder(payment, row);
  await markPaid(cfg, {
    orderId,
    paymentId: payment.id,
    signature: null,
    email: safeEmail(payment.email),
  });
  return (await getOrderRow(cfg, orderId)) || row;
}

function safeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

function createToken(secret, kind, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${kind}.${body}`).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(secret, kind, token) {
  if (!token || typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = crypto.createHmac("sha256", secret).update(`${kind}.${body}`).digest();
  let provided;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(expected, provided)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (!Number.isInteger(payload.e) || payload.e < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.o !== "string" || !ORDER_ID_RE.test(payload.o)) return null;
  if (kind === "a" && (typeof payload.p !== "string" || !PAYMENT_ID_RE.test(payload.p))) return null;
  return payload;
}

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function isHttps(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (proto) return proto === "https";
  return Boolean(req.socket?.encrypted);
}

function cookieHeader(req, name, value, maxAgeSeconds) {
  const secure = isHttps(req) ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/api/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearCookieHeader(req, name) {
  return cookieHeader(req, name, "", 0);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function accessToken(cfg, orderId, paymentId) {
  return createToken(cfg.downloadSecret, "a", {
    o: orderId,
    p: paymentId,
    e: nowSeconds() + cfg.accessDays * 86400,
  });
}

function pendingToken(cfg, orderId) {
  return createToken(cfg.downloadSecret, "p", {
    o: orderId,
    e: nowSeconds() + cfg.pendingDays * 86400,
  });
}

async function handleCreateOrder(req, res) {
  requireMethod(req, "POST");
  const cfg = getConfig();
  assertSameOrigin(req, cfg);
  assertRateLimit(req, "create-order", 10, 60_000);
  await readJsonBody(req);

  const receipt = `sps_ebook_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const order = await razorpayRequest(cfg, "/orders", {
    method: "POST",
    body: {
      amount: cfg.pricePaise,
      currency: cfg.currency,
      receipt,
      notes: {
        product_id: PRODUCT_ID,
        product_name: PRODUCT_NAME,
      },
    },
  });

  assertOrderMatchesProduct(cfg, order);
  await insertOrderRow(cfg, {
    orderId: order.id,
    amount: Number(order.amount),
    currency: String(order.currency || cfg.currency).toUpperCase(),
  });

  sendJson(
    res,
    200,
    {
      ok: true,
      keyId: cfg.keyId,
      orderId: order.id,
      amount: cfg.pricePaise,
      currency: cfg.currency,
      productName: PRODUCT_NAME,
    },
    {
      "Set-Cookie": cookieHeader(req, PENDING_COOKIE, pendingToken(cfg, order.id), cfg.pendingDays * 86400),
    },
  );
}

async function captureAuthorizedPayment(cfg, paymentId, payment) {
  try {
    await razorpayRequest(cfg, `/payments/${encodeURIComponent(paymentId)}/capture`, {
      method: "POST",
      body: { amount: payment.amount, currency: payment.currency },
    });
  } catch {
    // Re-fetch below. If another process captured it, the captured state is what matters.
  }
  return razorpayRequest(cfg, `/payments/${encodeURIComponent(paymentId)}`);
}

async function handleVerifyPayment(req, res) {
  requireMethod(req, "POST");
  const cfg = getConfig();
  assertSameOrigin(req, cfg);
  assertRateLimit(req, "verify-payment", 30, 60_000);

  const body = await readJsonBody(req);
  const orderId = stringField(body, "razorpay_order_id", 64);
  const paymentId = stringField(body, "razorpay_payment_id", 64);
  const signature = stringField(body, "razorpay_signature", 128);

  if (!ORDER_ID_RE.test(orderId) || !PAYMENT_ID_RE.test(paymentId) || !SIGNATURE_RE.test(signature)) {
    throw new HttpError(400, "invalid_request", "Invalid payment details.");
  }
  if (!verifyCheckoutSignature(orderId, paymentId, signature, cfg.keySecret)) {
    throw new HttpError(400, "invalid_signature", "Payment verification failed. Please contact support.");
  }

  let payment = await razorpayRequest(cfg, `/payments/${encodeURIComponent(paymentId)}`);
  if (payment?.order_id !== orderId) {
    throw new HttpError(409, "payment_order_mismatch", "This payment does not belong to the eBook order.");
  }

  if (payment.status === "failed") {
    await ensureOrderRow(cfg, orderId, payment);
    await markFailed(cfg, orderId);
    throw new HttpError(409, "payment_failed", "This payment failed. Please try again.");
  }

  if (payment.status === "authorized") {
    payment = await captureAuthorizedPayment(cfg, paymentId, payment);
  }

  if (payment.status !== "captured" || payment.captured === false) {
    throw new HttpError(
      409,
      "payment_not_captured",
      "The payment is not captured yet. If money was debited, wait a minute and use Retry verification.",
    );
  }

  const row = await ensureOrderRow(cfg, orderId, payment);
  assertOrderRowMatchesProduct(row);
  assertPaymentMatchesOrder(payment, row);

  await markPaid(cfg, {
    orderId,
    paymentId,
    signature,
    email: safeEmail(payment.email),
  });

  sendJson(
    res,
    200,
    { ok: true, downloadUrl: "/api/download", orderId, paymentId },
    {
      "Set-Cookie": [
        cookieHeader(req, ACCESS_COOKIE, accessToken(cfg, orderId, paymentId), cfg.accessDays * 86400),
        clearCookieHeader(req, PENDING_COOKIE),
      ],
    },
  );
}

async function handleAccess(req, res) {
  requireMethod(req, "GET");
  const cfg = getConfig();
  assertRateLimit(req, "access", 60, 60_000);
  const cookies = parseCookies(req);

  const access = verifyToken(cfg.downloadSecret, "a", cookies[ACCESS_COOKIE]);
  if (access) {
    const row = await getPaidRow(cfg, access.p, access.o);
    if (row) {
      assertOrderRowMatchesProduct(row);
      sendJson(res, 200, { ok: true, paid: true, downloadUrl: "/api/download" });
      return;
    }
  }

  const pending = verifyToken(cfg.downloadSecret, "p", cookies[PENDING_COOKIE]);
  if (pending) {
    let row = await getOrderRow(cfg, pending.o);
    let reconcileFailed = false;
    let reconcilePending = false;

    if (!row || (row.status !== "paid" && row.status !== "refunded")) {
      try {
        row = await reconcileOrderPayment(cfg, pending.o);
      } catch (error) {
        reconcileFailed = error instanceof HttpError && error.status >= 400 && error.status < 500;
        reconcilePending = !reconcileFailed;
        console.error(
          "[ebook] access reconciliation error:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (row?.status === "paid" && row.razorpay_payment_id) {
      assertOrderRowMatchesProduct(row);
      sendJson(
        res,
        200,
        { ok: true, paid: true, downloadUrl: "/api/download" },
        {
          "Set-Cookie": cookieHeader(
            req,
            ACCESS_COOKIE,
            accessToken(cfg, row.razorpay_order_id, row.razorpay_payment_id),
            cfg.accessDays * 86400,
          ),
        },
      );
      return;
    }

    const refunded = row?.status === "refunded";
    const isPending = !refunded && (row?.status === "created" || (!row && reconcilePending));
    const clearCookies = [clearCookieHeader(req, ACCESS_COOKIE)];
    if (refunded) clearCookies.push(clearCookieHeader(req, PENDING_COOKIE));

    sendJson(
      res,
      200,
      {
        ok: true,
        paid: false,
        pending: isPending,
        refunded,
      },
      { "Set-Cookie": clearCookies },
    );
    return;
  }

  sendJson(
    res,
    200,
    { ok: true, paid: false, pending: false },
    { "Set-Cookie": clearCookieHeader(req, ACCESS_COOKIE) },
  );
}

async function handleDownload(req, res) {
  requireMethod(req, "GET");
  const cfg = getConfig();
  const cookies = parseCookies(req);

  let access = verifyToken(cfg.downloadSecret, "a", cookies[ACCESS_COOKIE]);
  let row = access ? await getPaidRow(cfg, access.p, access.o) : null;
  let issuedAccessToken = null;

  if (!row) {
    const pending = verifyToken(cfg.downloadSecret, "p", cookies[PENDING_COOKIE]);
    if (pending) {
      let candidate = await getOrderRow(cfg, pending.o);
      if (!candidate || (candidate.status !== "paid" && candidate.status !== "refunded")) {
        try {
          candidate = await reconcileOrderPayment(cfg, pending.o);
        } catch (error) {
          console.error(
            "[ebook] download reconciliation error:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (candidate?.status === "paid" && candidate.razorpay_payment_id) {
        row = candidate;
        access = { o: candidate.razorpay_order_id, p: candidate.razorpay_payment_id };
        issuedAccessToken = accessToken(cfg, candidate.razorpay_order_id, candidate.razorpay_payment_id);
      }
    }
  }

  if (!row) {
    throw new HttpError(401, "download_not_authorised", "Please complete your eBook purchase to download this file.");
  }

  assertOrderRowMatchesProduct(row);
  if (row.status !== "paid") {
    throw new HttpError(403, "download_not_authorised", "This purchase is not active. Please contact support.");
  }
  if (row.razorpay_order_id !== access.o || row.razorpay_payment_id !== access.p) {
    throw new HttpError(403, "download_not_authorised", "This download link is not valid.");
  }

  const encodedBucket = encodeURIComponent(cfg.bucket);
  const storagePaths = [cfg.objectPath];
  const bucketPrefix = `${cfg.bucket}/`;
  if (cfg.objectPath.startsWith(bucketPrefix) && cfg.objectPath.length > bucketPrefix.length) {
    storagePaths.push(cfg.objectPath.slice(bucketPrefix.length));
  }
  const encodedPaths = [...new Set(storagePaths)].map((path) =>
    path.split("/").map((segment) => encodeURIComponent(segment)).join("/"),
  );

  let storageResponse = null;
  let storageResponsePath = null;
  let storageError = null;

  for (let index = 0; index < encodedPaths.length; index += 1) {
    const encodedPath = encodedPaths[index];
    try {
      const response = await fetch(
        `${cfg.supabaseUrl}/storage/v1/object/${encodedBucket}/${encodedPath}`,
        {
          headers: {
            apikey: cfg.supabaseKey,
            Authorization: `Bearer ${cfg.supabaseKey}`,
          },
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        },
      );
      if ((response.status === 404 || response.status === 400) && index < encodedPaths.length - 1) {
        try {
          await response.body?.cancel();
        } catch {}
        continue;
      }
      storageResponse = response;
      storageResponsePath = encodedPath;
      break;
    } catch (error) {
      storageError = error;
      break;
    }
  }

  if (!storageResponse) {
    throw new HttpError(
      503,
      "download_unavailable",
      "The download is temporarily unavailable. Please try again in a minute.",
      `Storage download failed: ${storageError instanceof Error ? storageError.message : String(storageError)}`,
    );
  }

  if (storageResponsePath !== encodedPaths[0]) {
    console.warn(`[ebook] storage fallback path used: ${storageResponsePath}`);
  }

  if (!storageResponse.ok) {
    throw new HttpError(
      storageResponse.status === 404 ? 503 : 502,
      "download_unavailable",
      "The download is temporarily unavailable. Please contact support.",
      `Storage download returned HTTP ${storageResponse.status}`,
    );
  }

  const bytes = Buffer.from(await storageResponse.arrayBuffer());
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new HttpError(
      502,
      "download_unavailable",
      "The download is temporarily unavailable. Please contact support.",
      "Stored object is not a PDF",
    );
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${cfg.fileName}"`);
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (issuedAccessToken) {
    res.setHeader("Set-Cookie", cookieHeader(req, ACCESS_COOKIE, issuedAccessToken, cfg.accessDays * 86400));
  }
  res.end(bytes);
}

async function handleWebhook(req, res) {
  requireMethod(req, "POST");
  const cfg = getConfig();
  if (cfg.webhookSecret.length < 16) {
    throw new HttpError(
      500,
      "server_not_configured",
      "Secure checkout is not configured yet. Please contact support.",
      "Missing or invalid RAZORPAY_WEBHOOK_SECRET",
    );
  }
  const signature = String(req.headers["x-razorpay-signature"] || "").trim();
  if (!signature) {
    throw new HttpError(400, "missing_signature", "Invalid webhook signature.");
  }

  const rawBody = await readRawBody(req, MAX_WEBHOOK_BYTES);
  if (!verifyWebhookSignature(rawBody, signature, cfg.webhookSecret)) {
    throw new HttpError(400, "invalid_webhook_signature", "Invalid webhook signature.");
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid webhook payload.");
  }

  const event = String(payload?.event || "");
  const payment = payload?.payload?.payment?.entity || null;
  const order = payload?.payload?.order?.entity || null;
  const refund = payload?.payload?.refund?.entity || null;

  try {
    if (event === "payment.captured") {
      await processCapturedPayment(cfg, payment);
    } else if (event === "payment.authorized") {
      if (payment?.id && payment?.order_id) {
        const row = await ensureOrderRow(cfg, payment.order_id, payment);
        assertPaymentMatchesOrder(payment, row);
        const settled = payment.status === "authorized"
          ? await captureAuthorizedPayment(cfg, payment.id, payment)
          : payment;
        await processCapturedPayment(cfg, settled);
      }
    } else if (event === "order.paid") {
      if (payment) {
        await processCapturedPayment(cfg, payment);
      } else if (order?.id) {
        const payments = await razorpayRequest(cfg, `/orders/${encodeURIComponent(order.id)}/payments`);
        const captured = Array.isArray(payments?.items)
          ? payments.items.find((item) => item?.status === "captured" && item?.captured !== false)
          : null;
        if (captured) await processCapturedPayment(cfg, captured);
      }
    } else if (event === "payment.failed") {
      if (payment?.order_id && ORDER_ID_RE.test(payment.order_id)) {
        await markFailed(cfg, payment.order_id);
      }
    } else if (event === "refund.processed") {
      if (refund?.payment_id && PAYMENT_ID_RE.test(refund.payment_id)) {
        const row = await getPaidRowByPaymentId(cfg, refund.payment_id);
        if (row && Number(refund.amount) >= Number(row.amount)) {
          await markRefunded(cfg, refund.payment_id);
        }
      }
    }
  } catch (error) {
    console.error("[ebook] webhook processing error:", error instanceof Error ? error.message : String(error));
    if (error instanceof HttpError && error.status >= 500) {
      throw error;
    }
  }

  sendJson(res, 200, { ok: true });
}

async function processCapturedPayment(cfg, payment) {
  if (!payment?.id || !payment?.order_id) return;
  if (!PAYMENT_ID_RE.test(payment.id) || !ORDER_ID_RE.test(payment.order_id)) return;

  const row = await ensureOrderRow(cfg, payment.order_id, payment);
  assertPaymentMatchesOrder(payment, row);
  if (payment.status !== "captured" || payment.captured === false) return;

  await markPaid(cfg, {
    orderId: payment.order_id,
    paymentId: payment.id,
    signature: null,
    email: safeEmail(payment.email),
  });
}

function stringField(object, name, maxLength) {
  const value = object?.[name];
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", "Invalid payment details.");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new HttpError(400, "invalid_request", "Invalid payment details.");
  }
  return trimmed;
}
