// 聯絡我們：把表單內容用 Resend 寄到站長信箱。
//
// 聯絡頁是公開頁，不用登入就能寫信，所以這裡不驗身分；
// 靠三件事擋垃圾信：honeypot 欄位（機器人會填、真人看不到）、欄位長度上限、
// 同一個 IP 一小時最多 RATE_MAX 封（記憶體計數，Edge 實例重啟就歸零，聊勝於無）。
//
//   POST /functions/v1/contact
//   { name, company?, email, topic, body, website? }   ← website 是 honeypot，有值就假裝成功
//
// 回 { ok:true } 或 { error }
//
// 寄件走 Resend（https://resend.com）。沒驗網域時只能用 onboarding@resend.dev 當寄件人，
// 而且只能寄到 Resend 帳號本人的信箱——剛好就是站長自己，夠用。
// 之後把 aiqkangber.com 驗過就可以把 CONTACT_FROM 換成自己的網域。
// 訪客的信箱放在 reply_to，Gmail 直接按「回覆」就回到對方那裡。

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const CONTACT_TO = Deno.env.get("CONTACT_TO") ?? "asdtodd42@gmail.com";
const CONTACT_FROM = Deno.env.get("CONTACT_FROM") ?? "校稿王 <onboarding@resend.dev>";

const MAX = { name: 60, company: 80, email: 120, topic: 30, body: 3000 };
const RATE_MAX = 5;                 // 每個 IP 每小時
const RATE_WINDOW = 60 * 60 * 1000;

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

// ── 限流：IP → 這一小時內的時間戳
const hits = new Map<string, number[]>();
function tooMany(ip: string) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW);
  if (list.length >= RATE_MAX) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  return false;
}

function str(v: unknown, max: number) {
  return (typeof v === "string" ? v : "").trim().slice(0, max);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "只接受 POST" });
  if (!RESEND_API_KEY) return json(500, { error: "還沒設定 RESEND_API_KEY" });

  let data: Record<string, unknown>;
  try { data = await req.json(); } catch { return json(400, { error: "要 JSON" }); }

  // honeypot：真人看不到這欄，有值就是機器人；回成功讓它以為得逞
  if (str(data.website, 200)) return json(200, { ok: true });

  const name = str(data.name, MAX.name);
  const company = str(data.company, MAX.company);
  const email = str(data.email, MAX.email);
  const topic = str(data.topic, MAX.topic) || "其他";
  const body = str(data.body, MAX.body);

  if (!name || !email || !body) return json(400, { error: "姓名、信箱、內容都要填" });
  if (!EMAIL_RE.test(email)) return json(400, { error: "信箱格式不對" });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (tooMany(ip)) return json(429, { error: "寄太多了，一小時後再試" });

  const text = [
    `姓名：${name}`,
    `公司：${company || "（未填）"}`,
    `信箱：${email}`,
    `主題：${topic}`,
    "",
    body,
    "",
    "──",
    `來自校稿王聯絡表單 · ${new Date().toISOString()} · IP ${ip}`,
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: CONTACT_FROM,
      to: [CONTACT_TO],
      reply_to: email,
      subject: `[校稿王] ${topic}：${name}`,
      text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("resend failed", res.status, detail);
    return json(502, { error: "信寄不出去，稍後再試" });
  }
  return json(200, { ok: true });
});
