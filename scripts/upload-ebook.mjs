import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const source = String(process.argv[2] || process.env.EBOOK_SOURCE_PDF || "").trim();
if (!source) {
  console.error("Usage: node scripts/upload-ebook.mjs /path/to/ai-agent-automation-income-blueprint.pdf");
  process.exit(1);
}

function requireEnv(name, minLength = 1) {
  const value = String(process.env[name] || "").trim();
  if (!value || value.length < minLength) {
    throw new Error(`Missing or invalid ${name}`);
  }
  return value;
}

function safeObjectPath(value) {
  const objectPath = String(value || "").trim().replace(/\\/g, "/");
  if (
    !objectPath ||
    objectPath.startsWith("/") ||
    objectPath.endsWith("/") ||
    objectPath.includes("..") ||
    objectPath.includes("//") ||
    !/\.pdf$/i.test(objectPath)
  ) {
    throw new Error("Invalid EBOOK_STORAGE_PATH");
  }
  return objectPath;
}

const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", 20);
const bucket = String(process.env.EBOOK_STORAGE_BUCKET || "ebooks").trim();
const objectPath = safeObjectPath(
  process.env.EBOOK_STORAGE_PATH || "ai-agent-automation-income-blueprint.pdf",
);

if (!/^[A-Za-z0-9._-]{1,64}$/.test(bucket)) {
  throw new Error("Invalid EBOOK_STORAGE_BUCKET");
}

const fileStat = await stat(source);
if (!fileStat.isFile() || fileStat.size === 0) {
  throw new Error("Source PDF is empty or is not a file");
}

const bytes = await readFile(source);
if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
  throw new Error("Source file is not a PDF");
}

const sourceHash = createHash("sha256").update(bytes).digest("hex");
const encodedBucket = encodeURIComponent(bucket);
const encodedPath = objectPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
const objectUrl = `${supabaseUrl}/storage/v1/object/${encodedBucket}/${encodedPath}`;

const upload = await fetch(objectUrl, {
  method: "POST",
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/pdf",
    "Cache-Control": "private, max-age=0",
    "x-upsert": "true",
  },
  body: bytes,
});

if (!upload.ok) {
  const detail = await upload.text().catch(() => "");
  throw new Error(`Upload failed with HTTP ${upload.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
}

const check = await fetch(objectUrl, {
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  },
  cache: "no-store",
});

if (!check.ok) {
  throw new Error(`Verification download failed with HTTP ${check.status}`);
}

const storedBytes = Buffer.from(await check.arrayBuffer());
const storedHash = createHash("sha256").update(storedBytes).digest("hex");
if (storedHash !== sourceHash) {
  throw new Error("Uploaded file hash does not match the source PDF");
}

console.log(`Uploaded and verified ${bucket}/${objectPath}`);
console.log(`Size: ${bytes.length} bytes`);
console.log(`SHA-256: ${sourceHash}`);
