// 綠界金流（AIO 信用卡一次付清）：建訂單、收付款通知、把瀏覽器導回感謝頁。
//
// 同一支函式三個路徑：
//   POST /ecpay/create   前端（已登入）→ 建 orders 一列，回綠界表單欄位（含 CheckMacValue），
//                        前端拿到後自動 POST 到綠界付款頁
//   POST /ecpay/notify   綠界 ReturnURL（Server-to-Server）→ 驗 CheckMacValue，開通，回 1|OK
//   POST /ecpay/return   綠界 OrderResultURL（消費者的瀏覽器）→ 驗 CheckMacValue，開通，
//                        303 導回前端 #thanks?o=訂單編號
//
// notify 和 return 都會開通（mark_order_paid 是冪等的），誰先到都行，
// 使用者回到感謝頁時狀態已經在資料庫裡。
//
// 環境變數（Supabase Dashboard → Edge Functions → Secrets）：
//   ECPAY_ENV            stage（預設，打 payment-stage）／ prod
//   ECPAY_MERCHANT_ID    prod 必填；stage 沒設就用綠界公開測試帳號 3002607
//   ECPAY_HASH_KEY       同上
//   ECPAY_HASH_IV        同上
//   ECPAY_CALLBACK_BASE  選填，回呼網址的前綴，預設 {SUPABASE_URL}/functions/v1/ecpay
//   SITE_URL             選填，前端網址；前端沒帶合法 returnTo 時用這個
//
// 規格來源：web_fetch developers.ecpay.com.tw/2862.md（產生訂單）、2878.md（付款結果通知）、
//           2858.md（介接注意事項），2026-09-12。CheckMacValue 演算法對照 ECPay PHP SDK。
import { createClient } from "npm:@supabase/supabase-js@2";

const ENV = Deno.env.get("ECPAY_ENV") === "prod" ? "prod" : "stage";
// 綠界公開測試帳號（所有開發者共用），只在 stage 當預設值
const STAGE_TEST = { id: "3002607", key: "pwFHCqoQZGmho4w6", iv: "EkRm7iFT261dpevs" };
const MERCHANT_ID = Deno.env.get("ECPAY_MERCHANT_ID") || (ENV === "stage" ? STAGE_TEST.id : "");
const HASH_KEY = Deno.env.get("ECPAY_HASH_KEY") || (ENV === "stage" ? STAGE_TEST.key : "");
const HASH_IV = Deno.env.get("ECPAY_HASH_IV") || (ENV === "stage" ? STAGE_TEST.iv : "");
const AIO_URL = ENV === "prod"
  ? "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5"
  : "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CALLBACK_BASE = (Deno.env.get("ECPAY_CALLBACK_BASE") || SUPABASE_URL + "/functions/v1/ecpay").replace(/\/+$/, "");
const SITE_URL = Deno.env.get("SITE_URL") ?? "";

// 價格在這裡定，前端 index.html 的 PLAN_INFO 只是顯示用，改價兩邊都要改。
const PLANS: Record<string, { amount: number; days: number; item: string }> = {
  monthly: { amount: 180, days: 30, item: "校稿王 付費版 30 天" },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}
function text(status: number, body: string) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
function redirect(to: string) {
  return new Response(null, { status: 303, headers: { Location: to } });
}

// ── CheckMacValue（SHA256）──────────────────────────────
// 步驟照 PHP SDK：去掉 CheckMacValue → key 不分大小寫排序 → HashKey=…&k=v&…&HashIV=…
// → 綠界式 urlencode → SHA256 → 大寫。
// 綠界式 urlencode = PHP urlencode（空格是 +）→ 全小寫 → 把 .NET 不編碼的 7 個字元還原。
// encodeURIComponent 跟 PHP urlencode 差三處：空格 %20（要換 +）、~ 不編碼（要換 %7e）、
// ' 不編碼（要換 %27）。
function ecpayUrlEncode(s: string): string {
  let e = encodeURIComponent(s).replace(/%20/g, "+").replace(/~/g, "%7e").replace(/'/g, "%27");
  e = e.toLowerCase();
  const back: [string, string][] = [
    ["%2d", "-"], ["%5f", "_"], ["%2e", "."], ["%21", "!"], ["%2a", "*"], ["%28", "("], ["%29", ")"],
  ];
  for (const [from, to] of back) e = e.split(from).join(to);
  return e;
}

async function checkMacValue(params: Record<string, string>): Promise<string> {
  const keys = Object.keys(params).filter((k) => k !== "CheckMacValue")
    .sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  const raw = `HashKey=${HASH_KEY}&` + keys.map((k) => `${k}=${params[k]}`).join("&") + `&HashIV=${HASH_IV}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ecpayUrlEncode(raw)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// 固定時間比較，不用 ===
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function verify(params: Record<string, string>): Promise<boolean> {
  const got = params.CheckMacValue || "";
  if (!got) return false;
  return safeEqual(got, await checkMacValue(params));
}

// ── 小工具 ─────────────────────────────────────────────
// 綠界要台北時間 yyyy/MM/dd HH:mm:ss；Edge Function 的時區是 UTC，自己加 8 小時
function taipei(): Date { return new Date(Date.now() + 8 * 3600 * 1000); }
const p2 = (n: number) => String(n).padStart(2, "0");
function tradeDate(): string {
  const d = taipei();
  return `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

// MerchantTradeNo：英數字、20 字內、永久唯一。K + yyMMddHHmmss + 4 碼亂數 = 17 字。
// 亂數字元拿掉會看錯的 0O1I。
function makeTradeNo(): string {
  const d = taipei();
  const stamp = p2(d.getUTCFullYear() % 100) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) +
    p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds());
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rnd = crypto.getRandomValues(new Uint8Array(4));
  let tail = "";
  for (const b of rnd) tail += chars[b % chars.length];
  return "K" + stamp + tail;
}

// 前端送來的導回網址只留 origin + path，去掉 query 和 hash，且只收 http(s)
function safeSite(s: unknown): string {
  if (typeof s !== "string" || !s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return (u.origin + u.pathname).slice(0, 180);
  } catch { return ""; }
}

// 綠界 POST 的是 application/x-www-form-urlencoded
async function formParams(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(await req.text())) out[k] = v;
  return out;
}

// 綠界的 PaymentDate 是台北時間 yyyy/MM/dd HH:mm:ss，轉成 Postgres 看得懂的字串
function toTimestamp(s: string | undefined): string | null {
  if (!s || !/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return null;
  return s.replace(/\//g, "-") + "+08:00";
}

function admin() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// ── create：建訂單、回綠界表單 ──────────────────────────
async function handleCreate(req: Request): Promise<Response> {
  // 驗身分：前端用 publishable key，閘道不驗 JWT，這裡自己驗
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "請先登入" });
  const sb = admin();
  const { data: { user }, error: uErr } = await sb.auth.getUser(token);
  if (uErr || !user) return json(401, { error: "登入已失效，請重新登入" });

  let body: { plan?: string; email?: string; taxId?: string; returnTo?: string };
  try { body = await req.json(); } catch { return json(400, { error: "請求不是 JSON" }); }
  const planKey = String(body.plan || "");
  const plan = PLANS[planKey];
  if (!plan) return json(400, { error: "沒有這個方案" });
  const email = String(body.email || user.email || "").trim().slice(0, 200);
  const taxId = String(body.taxId || "").replace(/\D/g, "");
  if (taxId && taxId.length !== 8) return json(400, { error: "統一編號要 8 碼數字" });
  const returnTo = safeSite(body.returnTo) || safeSite(SITE_URL);
  if (!returnTo) return json(400, { error: "沒有合法的導回網址（前端要帶 returnTo，或在後端設 SITE_URL）" });

  const no = makeTradeNo();
  const { error: iErr } = await sb.from("orders").insert({
    merchant_trade_no: no, user_id: user.id, plan: planKey,
    amount: plan.amount, days: plan.days, email, tax_id: taxId, return_to: returnTo,
  });
  if (iErr) return json(500, { error: "建訂單失敗：" + iErr.message });

  // 欄位名稱、必填規則：developers.ecpay.com.tw/2862.md。
  // TradeDesc / ItemName 不能有特殊符號和系統指令關鍵字（WAF 會擋），ItemName 多項用 # 分隔。
  // ReturnURL（S2S）跟 OrderResultURL（瀏覽器）不能是同一個網址。
  const fields: Record<string, string> = {
    MerchantID: MERCHANT_ID,
    MerchantTradeNo: no,
    MerchantTradeDate: tradeDate(),
    PaymentType: "aio",
    TotalAmount: String(plan.amount),
    TradeDesc: "校稿王訂閱",
    ItemName: plan.item,
    ReturnURL: CALLBACK_BASE + "/notify",
    OrderResultURL: CALLBACK_BASE + "/return",
    ClientBackURL: returnTo + "#plans",
    ChoosePayment: "Credit",
    EncryptType: "1",
    CustomField1: user.id,
  };
  fields.CheckMacValue = await checkMacValue(fields);
  return json(200, { action: AIO_URL, fields, orderNo: no, env: ENV });
}

// ── 套用綠界回傳的結果（notify / return 共用）────────────
// RtnCode 是字串 '1' 才算成功。SimulatePaid=1 是綠界後台的「模擬付款」，沒有真的扣款，
// 正式環境不開通；測試環境當成功處理，方便測流程。
async function applyResult(p: Record<string, string>): Promise<"paid" | "failed" | "skipped"> {
  const sb = admin();
  const no = p.MerchantTradeNo || "";
  if (!no) throw new Error("沒有 MerchantTradeNo");
  if (p.RtnCode === "1") {
    const simulated = p.SimulatePaid === "1";
    if (simulated && ENV === "prod") {
      console.warn("[ecpay] 正式環境收到模擬付款，不開通", no);
      return "skipped";
    }
    const amount = Number(p.TradeAmt);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("TradeAmt 不是正整數：" + p.TradeAmt);
    const { error } = await sb.rpc("mark_order_paid", {
      p_no: no, p_trade_no: p.TradeNo || "", p_amount: amount,
      p_paid_at: toTimestamp(p.PaymentDate), p_simulated: simulated, p_raw: p,
    });
    if (error) throw new Error("mark_order_paid：" + error.message);
    return "paid";
  }
  const { error } = await sb.rpc("mark_order_failed", {
    p_no: no, p_code: p.RtnCode || "", p_msg: p.RtnMsg || "", p_raw: p,
  });
  if (error) throw new Error("mark_order_failed：" + error.message);
  return "failed";
}

// ── notify：綠界 ReturnURL，10 秒內回 1|OK ───────────────
// 檢查碼不符不回 1|OK（綠界會重送，最多 4 次），讓錯的通知留在紀錄裡。
async function handleNotify(req: Request): Promise<Response> {
  const p = await formParams(req);
  if (!(await verify(p))) {
    console.warn("[ecpay] notify CheckMacValue 不符", p.MerchantTradeNo);
    return text(400, "0|CheckMacValue Error");
  }
  if (p.MerchantID !== MERCHANT_ID) return text(400, "0|MerchantID Error");
  try {
    const r = await applyResult(p);
    console.log("[ecpay] notify", p.MerchantTradeNo, r, p.RtnCode, p.RtnMsg);
  } catch (e) {
    console.error("[ecpay] notify 失敗", p.MerchantTradeNo, (e as Error).message);
    return text(500, "0|" + (e as Error).message);
  }
  return text(200, "1|OK");
}

// ── return：綠界 OrderResultURL，把人導回前端感謝頁 ───────
// 這是消費者瀏覽器發的 POST，不需要回 1|OK。查不到訂單或檢查碼不符就送回方案頁。
async function handleReturn(req: Request): Promise<Response> {
  const p = await formParams(req);
  const fallback = (safeSite(SITE_URL) || "/") + "#plans";
  if (!(await verify(p)) || p.MerchantID !== MERCHANT_ID) {
    console.warn("[ecpay] return CheckMacValue 不符", p.MerchantTradeNo);
    return redirect(fallback);
  }
  const no = p.MerchantTradeNo || "";
  const { data: order } = await admin().from("orders").select("return_to").eq("merchant_trade_no", no).maybeSingle();
  if (!order) return redirect(fallback);
  try { await applyResult(p); } catch (e) {
    // 開通失敗也先把人導回去，notify 那條會再試；感謝頁會顯示「還在確認」
    console.error("[ecpay] return 開通失敗", no, (e as Error).message);
  }
  return redirect((order.return_to || safeSite(SITE_URL) || "/") + "#thanks?o=" + encodeURIComponent(no));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "只接受 POST" });
  if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
    return json(500, { error: "伺服器還沒設定 ECPAY_MERCHANT_ID / ECPAY_HASH_KEY / ECPAY_HASH_IV" });
  }
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  try {
    if (route === "create") return await handleCreate(req);
    if (route === "notify") return await handleNotify(req);
    if (route === "return") return await handleReturn(req);
    return json(404, { error: "沒有這個路徑，只有 create / notify / return" });
  } catch (e) {
    console.error("[ecpay]", route, (e as Error).message);
    return json(500, { error: (e as Error).message });
  }
});
