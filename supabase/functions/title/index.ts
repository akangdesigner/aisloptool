// 生成標題：收文章全文，叫 Claude 回五個不同風格的候選標題。
//
// 免費方案每天 FREE_TITLE_DAILY 次（台北時間換日），付費不限。額度由 consume_daily()
// 原子扣，不靠前端擋。額度用完回 429，前端會蓋一張遮罩卡片。
//
// 環境變數（Supabase Dashboard → Edge Functions → Secrets）：
//   OPENROUTER_API_KEY  必填
//   TITLE_MODEL         選填，預設 anthropic/claude-sonnet-5
//   FREE_TITLE_DAILY    選填，預設 3（要跟 index.html 的 FREE_TITLE_DAILY 一致）
import { createClient } from "npm:@supabase/supabase-js@2";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const MODEL = Deno.env.get("TITLE_MODEL") ?? "anthropic/claude-sonnet-5";
const FREE_TITLE_DAILY = Number(Deno.env.get("FREE_TITLE_DAILY") ?? "3");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_CHARS = 6000;   // 只看文章前段就夠下標，超過的前端會先截

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

// 五種風格的 key 要跟 index.html 的 TITLE_STYLES 一致
const STYLES = ["直述", "疑問", "數字", "痛點", "故事"];

const SYSTEM = `你是中文編輯，專門幫文章下標。使用者給你一篇文章，你回五個候選標題，每種風格各一個。

五種風格：
- 直述：把文章在講什麼直接說清楚，不繞彎、不賣關子。
- 疑問：用讀者真的會問的問題當標題，不要明知故問。
- 數字：用文章裡真實出現的數量、次數、時間或項目數開頭。文章裡沒有數字就用文章真正涵蓋的項目數，不要編造。
- 痛點：點出讀者遇到的具體麻煩，用讀者自己會講的話。
- 故事：從文章裡一個具體的場景、人或事件切入。

規則：
1. 只能用文章裡有的資訊，不編造事實、數字、人名、結果。
2. 每個標題 12 到 28 個字，用繁體中文、台灣用語。
3. 不要 AI 腔：不用「深入探討」「揭密」「你不可不知」「終極指南」這類套話；不用「這不是…而是…」「不僅…更…」的反轉句型；不用破折號；不用驚嘆號堆疊。
4. 五個標題要真的不一樣，不是同一句話換幾個字。
5. 不加引號、不加編號、不解釋。

只輸出 JSON 陣列：[{"style":"直述","title":"…"},{"style":"疑問","title":"…"},{"style":"數字","title":"…"},{"style":"痛點","title":"…"},{"style":"故事","title":"…"}]`;

async function callModel(user: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENROUTER_API_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/asdto/aisloptool",
      "X-Title": "aisloptool",   // header 只能放 ASCII
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      temperature: 0.8,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    throw new Error("模型回錯：" + msg);
  }
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: { text?: string }) => p.text || "").join("");
  throw new Error("模型沒有回文字");
}

// 從回覆裡撈 JSON 陣列（模型偶爾會包 ``` 或加一句話），補齊五種風格的順序
function parseTitles(text: string): { style: string; title: string }[] {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b <= a) throw new Error("回覆裡沒有 JSON 陣列");
  const arr = JSON.parse(text.slice(a, b + 1));
  if (!Array.isArray(arr)) throw new Error("回覆不是陣列");
  const got = new Map<string, string>();
  const spare: string[] = [];
  for (const it of arr) {
    if (!it || typeof it.title !== "string" || !it.title.trim()) continue;
    const t = it.title.trim().replace(/^[「『"'\s]+|[」』"'\s]+$/g, "");
    const s = typeof it.style === "string" ? it.style.trim() : "";
    if (STYLES.includes(s) && !got.has(s)) got.set(s, t);
    else spare.push(t);
  }
  // 風格對不上的用剩下的標題補位，讓前端永遠拿到五格
  const out = STYLES.map((s) => ({ style: s, title: got.get(s) ?? spare.shift() ?? "" }))
    .filter((x) => x.title);
  if (!out.length) throw new Error("模型沒有回可用的標題");
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "只接受 POST" });
  if (!OPENROUTER_API_KEY) return json(500, { error: "伺服器還沒設定 OPENROUTER_API_KEY" });

  // 驗身分：前端用 publishable key，閘道不驗 JWT，這裡自己驗
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "請先登入" });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: { user }, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !user) return json(401, { error: "登入已失效，請重新登入" });

  // 讀請求
  let body: { text?: string };
  try { body = await req.json(); } catch { return json(400, { error: "請求不是 JSON" }); }
  const text = (typeof body.text === "string" ? body.text : "").trim();
  if (!text) return json(400, { error: "沒有文章內容" });
  if (text.length < 40) return json(400, { error: "文章太短，湊不出標題。請貼至少 40 字。" });
  const article = text.slice(0, MAX_CHARS);

  // 方案與額度：免費每天 FREE_TITLE_DAILY 次，付費不限
  // paid_until 為 null 是手動標記的永久付費；有值就要還沒過期
  const { data: prof } = await admin.from("profiles").select("plan, paid_until").eq("id", user.id).maybeSingle();
  const stillPaid = prof?.plan === "paid" && (!prof.paid_until || new Date(prof.paid_until) > new Date());
  const plan = stillPaid ? "paid" : "free";
  let remaining: number | null = null;
  if (plan === "free") {
    const { data: n, error: qErr } = await admin.rpc("consume_daily", {
      p_user: user.id, p_kind: "title", p_limit: FREE_TITLE_DAILY,
    });
    if (qErr) return json(500, { error: "額度檢查失敗：" + qErr.message });
    if (typeof n !== "number" || n < 0) {
      return json(429, {
        error: `免費版一天可以生 ${FREE_TITLE_DAILY} 次標題，今天用完了。明天零點重算，或升級付費版不限次數。`,
        remaining: 0, limit: FREE_TITLE_DAILY, plan,
      });
    }
    remaining = n;
  }

  let titles: { style: string; title: string }[];
  try {
    titles = parseTitles(await callModel("文章：\n" + article + "\n\n只回 JSON 陣列。"));
  } catch (e) {
    // 額度是先扣的，模型掛掉就退回去，不然使用者一天只有三次還白白少一次
    if (plan === "free") await admin.rpc("refund_daily", { p_user: user.id, p_kind: "title" });
    return json(502, { error: (e as Error).message });
  }

  return json(200, { titles, plan, remaining, limit: FREE_TITLE_DAILY, model: MODEL });
});
