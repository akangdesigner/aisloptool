-- v2.0.0：方案、免費額度、改寫歷史
-- 在 Supabase SQL Editor 整段貼上執行，或 supabase db push。

-- ── 方案 ───────────────────────────────────────────────
-- free / paid。結帳頁還是假的，先用 SQL 手動標記付費：
--   update public.profiles set plan = 'paid' where id = '<user uuid>';
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'paid')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "自己看自己的方案" on public.profiles;
create policy "自己看自己的方案" on public.profiles
  for select using (auth.uid() = id);

-- 新帳號自動建一列
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
-- 既有帳號補上
insert into public.profiles (id) select id from auth.users on conflict (id) do nothing;

-- ── 免費額度：每人每月幾篇 ─────────────────────────────
create table if not exists public.usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  ym text not null,                 -- 'YYYY-MM'，台北時間
  n int not null default 0,
  primary key (user_id, ym)
);
alter table public.usage enable row level security;
drop policy if exists "自己看自己的用量" on public.usage;
create policy "自己看自己的用量" on public.usage
  for select using (auth.uid() = user_id);

-- 只給 Edge Function（service role）呼叫：原子地 +1。
-- 超過上限回 -1，否則回扣完之後的剩餘次數。
create or replace function public.consume_quota(p_user uuid, p_limit int) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_ym text := to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM');
  v_n int;
begin
  insert into public.usage (user_id, ym, n) values (p_user, v_ym, 0)
    on conflict (user_id, ym) do nothing;
  select n into v_n from public.usage where user_id = p_user and ym = v_ym for update;
  if v_n >= p_limit then return -1; end if;
  update public.usage set n = v_n + 1 where user_id = p_user and ym = v_ym;
  return p_limit - v_n - 1;
end $$;
revoke execute on function public.consume_quota(uuid, int) from public, anon, authenticated;
grant execute on function public.consume_quota(uuid, int) to service_role;

-- ── 改寫歷史（付費才存）────────────────────────────────
create table if not exists public.rewrites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  source text not null default 'paste',    -- paste / txt / docx / pdf
  input text not null,
  output text not null,
  hard_before int not null default 0,
  hard_after int not null default 0,
  chars int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists rewrites_user_created on public.rewrites (user_id, created_at desc);
alter table public.rewrites enable row level security;
drop policy if exists "自己看自己的歷史" on public.rewrites;
create policy "自己看自己的歷史" on public.rewrites
  for select using (auth.uid() = user_id);
drop policy if exists "付費才能存歷史" on public.rewrites;
create policy "付費才能存歷史" on public.rewrites
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.plan = 'paid')
  );
drop policy if exists "自己刪自己的歷史" on public.rewrites;
create policy "自己刪自己的歷史" on public.rewrites
  for delete using (auth.uid() = user_id);
