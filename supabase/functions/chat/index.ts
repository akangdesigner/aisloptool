// 右下角小幫手：回答「這網站在幹嘛」跟常見問題。
//
// 公開頁面誰都能問，不用登入，所以沒有帳號額度可扣，改用記憶體裡的 IP 計數擋濫用：
// 每個 IP 每小時 CHAT_PER_HOUR 則。計數只活在單一 Edge 實例裡，冷啟動就歸零，
// 當作軟性煞車就好；真要精準限流得寫進資料庫。
//
// 網站知識全在 SYSTEM 裡，方案、價格、功能改了要來這裡同步，不然小幫手會講舊的。
//
// 環境變數（Supabase Dashboard → Edge Functions → Secrets）：
//   OPENROUTER_API_KEY  必填
//   CHAT_MODEL          選填，預設 anthropic/claude-sonnet-5
//   CHAT_PER_HOUR       選填，預設 30

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const MODEL = Deno.env.get("CHAT_MODEL") ?? "anthropic/claude-sonnet-5";
const PER_HOUR = Number(Deno.env.get("CHAT_PER_HOUR") ?? "30");

const MAX_TURNS = 8;        // 只帶最近幾輪，問答用不到長記憶
const MAX_USER_CHARS = 600; // 使用者一則的上限，前端也會擋
const MAX_BOT_CHARS = 1500; // 回傳歷史裡的助手訊息上限，防有人塞垃圾進來

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

const SYSTEM = `你是「校稿王」網站右下角的小幫手，幫來逛的人弄懂這個網站在做什麼、怎麼用、要不要付費。

## 網站是什麼
校稿王是一個網頁小工具：把中文文章貼進去，它會用 43 條規則掃出「AI 腔」用詞（像 ChatGPT 寫出來的那種口氣），畫底線、寫改法；再按一下「改寫」，交給 AI 模型改成自然的中文，左邊原文、右邊改好的，一段對一段對照。改寫版使用者自己看過再用。

## 六類規則
A 灌水開頭（深入探討、先誠實講）、B 浮誇強調（至關重要、觸目驚心）、C 情緒假詞（懂的都懂、接住你的情緒）、D 經典 AI 句型（這不是⋯而是⋯、破折號）、E 空洞／格式殘留（有人認為、Markdown 沒清乾淨的 **）、F 抽象化（效率的提升、大幅提升）。
朱紅實線是該改，墨色虛線是「待確認」，像破折號、「從⋯到⋯」、「非常／相當／極為」這三種不一定要改，使用者自己判斷。

## 功能
- 掃描：貼上文字就跑，在瀏覽器裡完成，不上傳、不用登入、不限次數。可以貼 HTML，會先去標籤再掃。
- 改寫：按「改寫」才會把文字送到伺服器交給 AI 模型改。要登入。
- 生成標題：改完可以叫它出五種風格的標題（直述、疑問、數字、痛點、故事）。免費版每天 3 次。
- 上傳 Word（.docx）、PDF：改完照原本格式下載。付費版限定。檔案在瀏覽器裡拆開，只有文字段落送去改寫，整份檔案不會離開使用者的電腦。
- AI 知識：一批文章，講 AI 腔怎麼來、怎麼看、怎麼改。
- AI 新聞：每天抓去 AI 味、AI 寫作、抓包 AI、AI 與 SEO 四個主題的新聞。

## 登入與隱私
- 掃描、看方案、看文章、看新聞都不用登入。改寫、上傳檔案、付款這三件事才要。
- 登入方式：Google 帳號，或 Email 加密碼。
- 掃描不上傳。改寫才會送文字，免費版改完不留檔。

## 方案
- 免費：NT$0。每月 5 篇改寫，字數不限；掃描不限次數；不留紀錄。
- 月付：NT$180／月。改寫不限次數、不限字數；上傳 Word、PDF；歷史紀錄；批次改寫一次 20 篇。
- 團隊：NT$680／月，5 個座位。月付全部功能，加共用規則表、發票與統一編號。要走「聯絡我們」。
- 年繳兩個月免費。
- 方案頁目前標註「價格未定案」。被問價格就講頁面上的數字，再補一句以方案頁為準。
- 付款走綠界（信用卡等）。取消訂閱：帳號頁按取消，用到期末為止。

## 頁面（網址用 # 開頭）
#home 首頁、#plans 訂閱方案、#knowledge AI知識、#news AI新聞、#contact 聯絡我們、#faq 常見問題、#login 登入。

## 常見問題的標準答案
- 誤判怎麼辦：到「聯絡我們」寫信，附上那句話，規則會改。
- 命中了一定要改嗎：實線是該改，虛線是待確認，自己判斷。
- 免費版能改幾次：每月 5 篇，字數不限。

## 回答方式
1. 用繁體中文、台灣用語。口氣像網站本身：直接、短、不裝熟。
2. 能一兩句講完就一兩句，最多四句。列方案這種真的需要條列的才分行。
3. 這個網站專門抓 AI 腔，你自己絕對不能有 AI 腔：不用「深入探討」「值得注意的是」「總的來說」，不用「這不是⋯而是⋯」「不僅⋯更⋯」，不用破折號，不用驚嘆號，不用「希望這對你有幫助」這種結尾。
4. 只回答跟這個網站有關的事。閒聊或無關的問題，一句話帶回來，例如「這個我不熟，網站的事都可以問我」。
5. 不編造。上面沒寫的功能、價格、時程，就說不確定，請對方到「聯絡我們」問。
6. 純文字，不用 Markdown 符號（不加 ** 也不加 #）。需要指路就講頁面名稱，例如「到上面導覽列的『訂閱方案』」。`;

type Msg = { role: "user" | "assistant"; content: string };

// 每個 IP 一小時一格，時間到整格重算。Map 只會長到有人來問過的 IP 數，順手把過期的清掉。
const bucket = new Map<string, { n: number; reset: number }>();
function throttle(ip: string): boolean {
  const now = Date.now();
  if (bucket.size > 5000) for (const [k, v] of bucket) if (v.reset < now) bucket.delete(k);
  const b = bucket.get(ip);
  if (!b || b.reset < now) { bucket.set(ip, { n: 1, reset: now + 3600_000 }); return true; }
  if (b.n >= PER_HOUR) return false;
  b.n++;
  return true;
}

function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for") || "";
  return xf.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
}

// 把前端送來的歷史洗乾淨：只留 user／assistant、去空白、截長度、只帶最後幾輪
function cleanHistory(raw: unknown): Msg[] {
  if (!Array.isArray(raw)) return [];
  const out: Msg[] = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    const cap = m.role === "user" ? MAX_USER_CHARS : MAX_BOT_CHARS;
    const c = m.content.trim().slice(0, cap);
    if (!c) continue;
    // 同角色連續兩則會被模型拒收，合併成一則
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n" + c;
    else out.push({ role: m.role, content: c });
  }
  const kept = out.slice(-MAX_TURNS * 2);
  // Anthropic 要求第一則是 user，截完開頭若是 assistant 就丟掉
  while (kept.length && kept[0].role !== "user") kept.shift();
  return kept;
}

async function callModel(messages: Msg[]): Promise<string> {
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
      max_tokens: 600,
      temperature: 0.4,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    throw new Error("模型回錯：" + msg);
  }
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) return c.map((p: { text?: string }) => p.text || "").join("").trim();
  throw new Error("模型沒有回文字");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "只接受 POST" });
  if (!OPENROUTER_API_KEY) return json(500, { error: "伺服器還沒設定 OPENROUTER_API_KEY" });

  let body: { messages?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: "請求不是 JSON" }); }
  const messages = cleanHistory(body.messages);
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return json(400, { error: "沒有問題內容" });

  if (!throttle(clientIp(req))) {
    return json(429, { error: "問太快了，一小時內問了太多次。休息一下再來，或到「聯絡我們」寫信。" });
  }

  try {
    const reply = await callModel(messages);
    if (!reply) throw new Error("模型回了空白");
    return json(200, { reply, model: MODEL });
  } catch (e) {
    return json(502, { error: (e as Error).message });
  }
});
