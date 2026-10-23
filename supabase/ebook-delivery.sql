-- Run this in the Supabase SQL editor for the project used by the eBook checkout.
-- It creates a server-only purchase table and a private storage bucket.
-- Keep the service_role key on the server only. No anon/authenticated policies are created.

create table if not exists public.ebook_purchases (
  id uuid primary key default gen_random_uuid(),
  product_id text not null default 'ai-agent-automation-income-blueprint',
  razorpay_order_id text not null unique,
  razorpay_payment_id text unique,
  razorpay_signature text,
  amount integer not null check (amount > 0),
  currency text not null default 'INR',
  status text not null default 'created'
    check (status in ('created', 'paid', 'failed', 'refunded')),
  buyer_email text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ebook_purchases_status_idx
  on public.ebook_purchases (status);

create or replace function public.ebook_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ebook_purchases_set_updated_at on public.ebook_purchases;

create trigger ebook_purchases_set_updated_at
before update on public.ebook_purchases
for each row
execute function public.ebook_set_updated_at();

alter table public.ebook_purchases enable row level security;

revoke all on table public.ebook_purchases from public;
revoke all on table public.ebook_purchases from anon;
revoke all on table public.ebook_purchases from authenticated;
grant all on table public.ebook_purchases to service_role;

-- Private bucket. Keep it private: downloads are proxied by the Vercel Function
-- after it verifies the signed purchase cookie and the paid database row.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ebooks', 'ebooks', false, 10485760, array['application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Do not add anon/authenticated select policies on storage.objects for this bucket.
-- The service_role used by the server-side function bypasses storage RLS.
-- This restrictive policy blocks the bucket even if permissive storage policies exist.
drop policy if exists "ebooks_deny_public" on storage.objects;

create policy "ebooks_deny_public"
on storage.objects
as restrictive
for all
to anon, authenticated
using (bucket_id <> 'ebooks')
with check (bucket_id <> 'ebooks');
