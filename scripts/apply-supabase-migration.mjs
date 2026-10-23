import { readFile } from "node:fs/promises";

const verifyOnly = process.argv.includes("--verify-only");

function requireEnv(name, minLength = 1) {
  const value = String(process.env[name] || "").trim();
  if (!value || value.length < minLength) {
    throw new Error(
      `Missing ${name}. Create a Supabase personal access token, then set ${name} locally (never in Vercel runtime).`,
    );
  }
  return value;
}

const accessToken = requireEnv("SUPABASE_ACCESS_TOKEN", 20);
const projectRef = requireEnv("SUPABASE_PROJECT_REF", 6);

if (!/^[a-z0-9]{6,32}$/.test(projectRef)) {
  throw new Error("SUPABASE_PROJECT_REF is not a valid project reference");
}

const endpoint = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`;

async function runQuery(query) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`Supabase Management API request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const detail = data?.message || data?.error || text.slice(0, 500) || `HTTP ${response.status}`;
    throw new Error(`Supabase migration request failed (HTTP ${response.status}): ${detail}`);
  }

  return data;
}

if (!verifyOnly) {
  const migration = await readFile(new URL("../supabase/ebook-delivery.sql", import.meta.url), "utf8");
  if (!migration.trim()) throw new Error("Migration file is empty");
  await runQuery(migration);
  console.log("Migration SQL applied.");
}

const checks = await runQuery(`
  select
    to_regclass('public.ebook_purchases') is not null as purchase_table_exists,
    (select public from storage.buckets where id = 'ebooks') as ebooks_bucket_public;
`);

console.log("Supabase verification result:");
console.log(JSON.stringify(checks, null, 2));

const result = Array.isArray(checks) ? checks[0] : checks;
if (!result || result.purchase_table_exists !== true) {
  throw new Error("ebook_purchases table was not found after the migration");
}
if (result.ebooks_bucket_public !== false) {
  throw new Error("ebooks storage bucket is missing or not private");
}

console.log("Supabase table and private bucket verified.");
