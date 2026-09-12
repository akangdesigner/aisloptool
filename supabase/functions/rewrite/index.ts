// 改寫：收段落陣列，叫 Claude 去 AI 味，回同樣編號的段落陣列。
//
// 前端把文章切成段落、再分批送（每批約 2500 字）。免費方案每月 FREE_MONTHLY 篇，
// 只在 part === 0 那批扣一次，長文分多批送不會重複扣。付費不限。
// source 為 docx／pdf（上傳檔案改寫）時只有付費方案能用。
//
// 模型走 OpenRouter（OpenAI 相容格式），換模型只要改環境變數。
//
// 環境變數（Supabase Dashboard → Edge Functions → Secrets）：
//   OPENROUTER_API_KEY  必填
//   REWRITE_MODEL       選填，預設 anthropic/claude-sonnet-5
//   FREE_MONTHLY        選填，預設 5（要跟 index.html 的 FREE_MONTHLY 一致）
import { createClient } from "npm:@supabase/supabase-js@2";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const MODEL = Deno.env.get("REWRITE_MODEL") ?? "anthropic/claude-sonnet-5";
const FREE_MONTHLY = Number(Deno.env.get("FREE_MONTHLY") ?? "5");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_CHARS = 12000;   // 單批段落總字數上限（前端會分批，這裡只是保險）
const MAX_PARAS = 200;

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

// ── 提示：跟 index.html 的六類規則對齊 ──────────────────
const SYSTEM = `你是中文校稿編輯，專門把「AI 腔」改成人寫的自然中文。使用者會給你一組編號段落，你逐段改寫。

要去掉的六類 AI 腔：
A 灌水開頭／過場報幕：「深入探討」「值得注意的是」「先誠實講」「說真的」「這篇會告訴你」「帶你了解」「舉個例子」「先交代一下」「簡單來說」「一句話總結：」「X 講完了，來接 Y」「來看真的」「真正好玩的才開始」「綜上所述」「總而言之」。處理：刪掉報幕，直接講那件事。
B 浮誇強調：「至關重要」「關鍵的一環」「不可磨滅」「凸顯了」「觸目驚心」「發人深省」「耐人尋味」。處理：換成具體後果或數字，沒有就刪。
C 情緒假詞：「懂的都懂」「接住你的情緒」之類裝熟空話。處理：刪掉或改成平實的說法。
D 經典 AI 句型：「這不是…而是…」「不僅是…更是…」工整反轉金句、「從…到…」假範圍、「閃得掉／躲不過」俏皮動詞、「根本不在同一個賽道」聳動斷言、「出手」武俠腔、破折號「——」濫用。處理：拆成平鋪直敘的句子，破折號改成逗號或句號。
E 空洞讚美／模糊歸因／格式殘留：「燈塔」「見證」、「有人認為」「批評者認為」、Markdown 殘留（**、##）。處理：讚美換可驗證事實，歸因指名或刪，Markdown 符號拿掉。
F 抽象化／缺錨點：「效率的提升」名詞化、「某個午後」「大幅提升」。處理：名詞化改回動詞，模糊時間與程度換具體的；沒有具體資料就直接刪掉修飾語，不要編數字。
另外：「非常／相當／極為」這類空形容詞能刪就刪。

改寫原則：
1. 保留原意、事實、數字、專有名詞、人稱、語氣與立場。不新增資訊，不編造細節。
2. 長度大致相同，可以略短。句子要有長有短，不要太工整、太對稱。
3. 每段獨立改寫。段數、順序、編號都不能變；不合併、不拆段、不新增段落。
4. 很短的段落（標題、清單項、一兩個詞）保持是標題或短句，不要擴寫成句子。沒有 AI 腔的段落原樣輸出。
5. 保留段落開頭的 Markdown 標記（# 標題、- 清單、1. 編號）與 HTML 標籤。
6. 用繁體中文、台灣用語。
7. 不加註解、不解釋、不加前言。只輸出 JSON 陣列：[{"i":1,"t":"改寫後的段落"},...]，i 對應輸入編號。`;

type Para = { i: number; t: string };
type Hint = { word: string; tip: string };

function buildUser(paras: Para[], hints: Hint[]) {
  let s = "";
  if (hints.length) {
    s += "本文掃描到的 AI 腔用詞（正則命中，優先處理）：\n";
    for (const h of hints) s += `- 「${h.word}」：${h.tip}\n`;
    s += "\n";
  }
  s += "段落（JSON）：\n" + JSON.stringify(paras);
  s += "\n\n只回 JSON 陣列。";
  return s;
}

async function callModel(system: string, user: string, maxTokens: number): Promise<string> {
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
      max_tokens: maxTokens,
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
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

// 從回覆裡撈 JSON 陣列（模型偶爾會包 ``` 或加一句話）
function parseParas(text: string, want: Set<number>): Map<number, string> {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b <= a) throw new Error("回覆裡沒有 JSON 陣列");
  const arr = JSON.parse(text.slice(a, b + 1));
  if (!Array.isArray(arr)) throw new Error("回覆不是陣列");
  const out = new Map<number, string>();
  for (const it of arr) {
    if (!it || typeof it.i !== "number" || typeof it.t !== "string") continue;
    if (want.has(it.i)) out.set(it.i, it.t);
  }
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
  let body: { paragraphs?: Para[]; hints?: Hint[]; part?: number; source?: string };
  try { body = await req.json(); } catch { return json(400, { error: "請求不是 JSON" }); }
  const paras = (body.paragraphs || []).filter((p) =>
    p && typeof p.i === "number" && typeof p.t === "string" && p.t.trim());
  if (!paras.length) return json(400, { error: "沒有段落" });
  if (paras.length > MAX_PARAS) return json(400, { error: `一批最多 ${MAX_PARAS} 段` });
  const total = paras.reduce((n, p) => n + p.t.length, 0);
  if (total > MAX_CHARS) return json(400, { error: `一批最多 ${MAX_CHARS} 字，請分批` });
  const hints = (body.hints || []).slice(0, 80)
    .filter((h) => h && typeof h.word === "string" && typeof h.tip === "string");
  const first = !body.part;   // undefined 或 0 都算第一批
  // 來源：paste（貼上）／docx／pdf。檔案改寫是付費功能，這裡擋住，不只靠前端
  const source = typeof body.source === "string" ? body.source : "paste";

  // 方案與額度
  // paid_until 為 null 是手動標記的永久付費；有值就要還沒過期
  const { data: prof } = await admin.from("profiles").select("plan, paid_until").eq("id", user.id).maybeSingle();
  const stillPaid = prof?.plan === "paid" && (!prof.paid_until || new Date(prof.paid_until) > new Date());
  const plan = stillPaid ? "paid" : "free";
  if ((source === "docx" || source === "pdf") && plan !== "paid") {
    return json(403, { error: "上傳 Word／PDF 改完照原格式下載，是付費版功能。升級後就能用。", plan });
  }
  let remaining: number | null = null;
  if (plan === "free" && first) {
    const { data: n, error: qErr } = await admin.rpc("consume_quota", { p_user: user.id, p_limit: FREE_MONTHLY });
    if (qErr) return json(500, { error: "額度檢查失敗：" + qErr.message });
    if (typeof n !== "number" || n < 0) {
      return json(429, { error: `免費版每月 ${FREE_MONTHLY} 篇，這個月用完了。下個月一號重算，或升級付費版不限次數。`, remaining: 0, plan });
    }
    remaining = n;
  }

  // 叫模型；段數對不上就再叫一次，還是不行就把缺的段落原樣回去
  const want = new Set(paras.map((p) => p.i));
  const maxTokens = Math.min(32000, Math.max(2000, Math.ceil(total * 2.2) + 500));
  const userMsg = buildUser(paras, hints);
  let got = new Map<number, string>();
  try {
    got = parseParas(await callModel(SYSTEM, userMsg, maxTokens), want);
    if (got.size < want.size) {
      const retry = await callModel(SYSTEM,
        userMsg + `\n\n注意：上一次少了幾段。輸入有 ${paras.length} 段，輸出也要剛好 ${paras.length} 段，每段的 i 都要對上。`,
        maxTokens);
      const more = parseParas(retry, want);
      for (const [k, v] of more) if (!got.has(k)) got.set(k, v);
    }
  } catch (e) {
    if (got.size === 0) return json(502, { error: (e as Error).message });
  }

  const out = paras.map((p) => ({ i: p.i, t: got.get(p.i) ?? p.t }));
  return json(200, { paragraphs: out, missing: paras.length - got.size, plan, remaining, model: MODEL });
});
