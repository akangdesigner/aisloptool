-- v2.1.0：綠界金流。訂單表、付費到期日、開通函式。
-- 在 Supabase SQL Editor 整段貼上執行，或 supabase db push。

-- ── 付費到期日 ─────────────────────────────────────────
-- plan = 'paid' 且（paid_until 是 null 或還沒過）才算付費。
-- null 保留給手動用 SQL 標記的永久付費帳號；線上刷卡每筆加 30 天。
alter table public.profiles add column if not exists paid_until timestamptz;

-- ── 訂單 ───────────────────────────────────────────────
-- merchant_trade_no 就是送給綠界的 MerchantTradeNo（20 字內、英數字、永久唯一）。
-- status：pending（建單、還沒付）／ paid ／ failed。
create table if not exists public.orders (
  merchant_trade_no text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null,                       -- 'monthly'
  amount int not null,
  days int not null default 30,             -- 付款成功後延長幾天
  email text not null default '',
  tax_id text not null default '',          -- 統一編號，之後開發票用
  return_to text not null default '',       -- 付完款把瀏覽器導回哪個網址（前端自己的 URL）
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  ecpay_trade_no text,                      -- 綠界的 TradeNo
  rtn_code text,
  rtn_msg text,
  simulated boolean not null default false, -- 綠界 SimulatePaid=1
  paid_at timestamptz,
  raw jsonb,                                -- 綠界通知的原始欄位，出事時對帳用
  created_at timestamptz not null default now()
);
create index if not exists orders_user_created on public.orders (user_id, created_at desc);
alter table public.orders enable row level security;
drop policy if exists "自己看自己的訂單" on public.orders;
create policy "自己看自己的訂單" on public.orders
  for select using (auth.uid() = user_id);
-- 寫入一律走 Edge Function（service role），前端沒有 insert / update 權限。

-- ── 開通：訂單標成 paid、方案延 30 天 ───────────────────
-- 只給 service role 呼叫。同一張訂單重複通知只會開通一次（綠界收不到 1|OK 會重送）。
-- 回傳值：true = 這次真的開通了；false = 早就付過、什麼都沒做。
create or replace function public.mark_order_paid(
  p_no text, p_trade_no text, p_amount int, p_paid_at timestamptz, p_simulated boolean, p_raw jsonb
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where merchant_trade_no = p_no for update;
  if not found then
    raise exception '訂單不存在：%', p_no;
  end if;
  if v_order.status = 'paid' then
    return false;
  end if;
  if v_order.amount <> p_amount then
    raise exception '金額對不上：訂單 % 應為 %，綠界回 %', p_no, v_order.amount, p_amount;
  end if;
  update public.orders
     set status = 'paid', ecpay_trade_no = p_trade_no, paid_at = coalesce(p_paid_at, now()),
         simulated = p_simulated, rtn_code = '1', rtn_msg = 'paid', raw = p_raw
   where merchant_trade_no = p_no;
  -- 還在付費期內就從到期日往後加，過期或第一次買就從現在起算
  update public.profiles
     set plan = 'paid',
         paid_until = greatest(coalesce(paid_until, now()), now()) + make_interval(days => v_order.days)
   where id = v_order.user_id;
  return true;
end $$;
revoke execute on function public.mark_order_paid(text, text, int, timestamptz, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.mark_order_paid(text, text, int, timestamptz, boolean, jsonb) to service_role;

-- 付款失敗：記下原因，已付過的不動
create or replace function public.mark_order_failed(p_no text, p_code text, p_msg text, p_raw jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.orders
     set status = 'failed', rtn_code = p_code, rtn_msg = p_msg, raw = p_raw
   where merchant_trade_no = p_no and status <> 'paid';
end $$;
revoke execute on function public.mark_order_failed(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mark_order_failed(text, text, text, jsonb) to service_role;

-- ── 歷史紀錄的 RLS 也要看到期日 ─────────────────────────
drop policy if exists "付費才能存歷史" on public.rewrites;
create policy "付費才能存歷史" on public.rewrites
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.plan = 'paid'
        and (p.paid_until is null or p.paid_until > now())
    )
  );
