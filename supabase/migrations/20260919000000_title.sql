-- 生成標題：每日額度
-- 在 Supabase SQL Editor 整段貼上執行，或 supabase db push。

-- ── 每日用量：每人每天每種功能幾次 ─────────────────────
-- kind 先只有 'title'，之後有別的每日限次功能可以沿用同一張表。
create table if not exists public.daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  ymd text not null,                -- 'YYYY-MM-DD'，台北時間
  kind text not null,               -- 'title'
  n int not null default 0,
  primary key (user_id, ymd, kind)
);
alter table public.daily_usage enable row level security;
drop policy if exists "自己看自己的每日用量" on public.daily_usage;
create policy "自己看自己的每日用量" on public.daily_usage
  for select using (auth.uid() = user_id);

-- 只給 Edge Function（service role）呼叫：原子地 +1。
-- 超過上限回 -1，否則回扣完之後的剩餘次數。跟 consume_quota 同一套做法。
create or replace function public.consume_daily(p_user uuid, p_kind text, p_limit int) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_ymd text := to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM-DD');
  v_n int;
begin
  insert into public.daily_usage (user_id, ymd, kind, n) values (p_user, v_ymd, p_kind, 0)
    on conflict (user_id, ymd, kind) do nothing;
  select n into v_n from public.daily_usage
    where user_id = p_user and ymd = v_ymd and kind = p_kind for update;
  if v_n >= p_limit then return -1; end if;
  update public.daily_usage set n = v_n + 1
    where user_id = p_user and ymd = v_ymd and kind = p_kind;
  return p_limit - v_n - 1;
end $$;
revoke execute on function public.consume_daily(uuid, text, int) from public, anon, authenticated;
grant execute on function public.consume_daily(uuid, text, int) to service_role;

-- 扣了但事情沒做成（模型掛掉）就退一次回去，別讓使用者白白少一次。
create or replace function public.refund_daily(p_user uuid, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_ymd text := to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM-DD');
begin
  update public.daily_usage set n = greatest(n - 1, 0)
    where user_id = p_user and ymd = v_ymd and kind = p_kind;
end $$;
revoke execute on function public.refund_daily(uuid, text) from public, anon, authenticated;
grant execute on function public.refund_daily(uuid, text) to service_role;
