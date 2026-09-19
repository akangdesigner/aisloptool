// AI 新聞：把 Google 新聞的 RSS 轉成 JSON，給前端用 GET 抓。
//
// Google 沒有公開的新聞 API，能拿的是 news.google.com/rss/search 的 RSS。
// 瀏覽器直接抓那個網址會被 CORS 擋，所以由這支函式代抓、解析成 JSON 再回去。
// 新聞頁是公開頁（跟 AI 知識一樣不用登入），所以這裡不驗身分。
//
//   GET /functions/v1/news?topic=deslop&n=20
//   GET /functions/v1/news?q=AI 寫作&n=10
//
// 回 { topic, query, count, items:[{ title, link, source, date }], cachedAt, fresh, filtered }
//
// topic 走白名單（key 要跟 index.html 的 NEWS_TOPICS 一致）；q 是自由關鍵字，長度有上限。
// 同一組關鍵字 15 分鐘內用記憶體快取，Google 那邊不用重打。
//
// 關聯度是這支函式的重點，分三層（`AI 寫作 OR ...` 這種裸查詢會被「AI」單字洗版）：
//   1. 查詢用引號片語（"AI味"、"AI寫作"），Google 只回真的出現該詞的新聞。
//   2. 標題過濾：一定要提到 AI、要命中該主題的 must、不能命中 DENY（股市題材、社會案件、
//      工業檢測這些同字不同義的），needText 的主題還要出現「文章／文案／稿」這類字眼。
//   3. 同一則新聞常被多家轉載，標題正規化後去重。
// 過濾完全空的話退回未過濾版本（filtered:false），免得版面開天窗。

type Topic = {
  q: string;          // 丟給 Google 的查詢
  must: RegExp;       // 標題必須命中
  needText?: boolean; // 還要命中 TEXT_RE（確定在講文字，不是影像或硬體）
  deny?: RegExp;      // 這個主題額外要排除的
};

const TOPICS: Record<string, Topic> = {
  // 去 AI 味：工具本身在做的事，關聯度最高，當預設
  deslop: {
    q: '"AI味" OR "AI 味" OR "AI腔" OR "去AI味" OR "機器感" OR "像AI寫的"',
    must: /AI\s?[味腔感]|機器感|去\s?AI|像\s?AI|AI\s?寫的/i,
  },
  // AI 寫作
  writing: {
    q: '"AI寫作" OR "AI 寫作" OR "AI寫文章" OR "AI寫稿" OR "AI代寫" OR "用AI寫"',
    must: /寫作|寫文|寫稿|代寫|撰寫|文筆|稿|文章|作文|投稿|編輯/,
    needText: true,
    deny: /程式碼|寫程式|工程師|開發者/,
  },
  // 抓包 AI：偵測工具、代筆爭議
  detect: {
    q: '"AI偵測器" OR "AI寫作偵測" OR "AI生成內容偵測" OR "AI文章偵測" OR "抓包AI" OR "AI代筆"',
    must: /偵測|檢測|抓包|辨識|識別|分辨|露餡|破綻|代筆|代寫|查核|判讀|揪出/,
    needText: true,
    deny: /女星|男星|藝人|偶像|粉絲|緋聞|分手|婚變|戀情|打臉|回嗆|嗆|截圖|阿嬤|母子|偷拍|判刑/,
  },
  // AI 與 SEO：AI 搜尋怎麼改寫內容規則。must 故意不收「搜尋」兩個字，
  // 不然「某某網站用了 AI 搜尋工具」這種資安新聞會整批洗進來。
  seo: {
    q: '"AI搜尋" OR "AI SEO" OR "AISEO" OR "GEO" OR "AI概覽" OR "生成式引擎最佳化"',
    must: /SEO|GEO|排名|能見度|流量|曝光|引用|摘要|內容行銷|最佳化|優化/i,
  },
};
const DEFAULT_TOPIC = "deslop";

// 標題一定要提到 AI
const AI_RE = /AI|ＡＩ|人工智[慧能]|ChatGPT|Claude|Gemini|GPT|語言模型|LLM/i;
// 一律排除：股市財經題材、社會案件、硬體／產線檢測（都跟「AI 寫字」無關但常同字）
const DENY =
  /股價|漲停|跌停|財報|法說|目標價|投信|ETF|美債|台股|收盤|個股|營收|概念股|加密|比特幣|幣圈|REIT|晶圓|良率|產線|訂單|擴廠|洗錢|詐騙|車禍|命案|球賽|颱風|彩券/;
// 確定在講文字
const TEXT_RE =
  /文章|文字|文案|寫作|寫文|寫稿|代寫|代筆|撰寫|文筆|稿|作文|論文|作業|投稿|報導|編輯|校稿|潤稿|內容|書|信|小說|履歷|簡報|貼文|評論/;

const MAX_Q = 120;        // 自由關鍵字長度上限
const MAX_N = 30;         // 一次最多回幾則
const FETCH_N = 80;       // 過濾前先抓幾則
const DEFAULT_N = 20;
const TTL = 15 * 60_000;  // 快取 15 分鐘

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(status: number, body: unknown, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

type Item = { title: string; link: string; source: string; date: string };

// ── RSS 解析 ────────────────────────────────────────
// Edge Runtime 沒有 DOMParser，RSS 結構又固定，所以用正則逐個 <item> 撈。
// 每個標籤一條字面正則（不用 new RegExp 拼字串，免得跳脫層數出錯）。

const TAG_RE = {
  title: /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i,
  link: /<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i,
  pubDate: /<pubDate(?:\s[^>]*)?>([\s\S]*?)<\/pubDate>/i,
  source: /<source(?:\s[^>]*)?>([\s\S]*?)<\/source>/i,
} as const;

function unwrap(s: string) {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (m ? m[1] : s).trim();
}

function decode(s: string) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")   // 放最後，免得把 &amp;lt; 解兩次
    .trim();
}

function pick(block: string, tag: keyof typeof TAG_RE) {
  const m = block.match(TAG_RE[tag]);
  return m ? decode(unwrap(m[1])) : "";
}

function parseRss(xml: string, limit: number): Item[] {
  const out: Item[] = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < limit) {
    const b = m[1];
    let title = pick(b, "title");
    const source = pick(b, "source");
    // Google 的標題結尾都掛「 - 媒體名」，來源另外有 <source>，重複的拿掉
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3)).trim();
    const link = pick(b, "link");
    if (!title || !link) continue;
    const pub = pick(b, "pubDate");
    const t = pub ? Date.parse(pub) : NaN;
    out.push({ title, link, source, date: isNaN(t) ? "" : new Date(t).toISOString() });
  }
  return out;
}

// ── 關聯度過濾 ──────────────────────────────────────

// 轉載時標題常被加前綴（「討論牆 | 」）或改標點，正規化後比對才抓得到同一則
function dedupeKey(title: string) {
  let t = title;
  const bar = t.indexOf("|");
  if (bar > 0 && bar <= 8) t = t.slice(bar + 1);   // 短前綴一律當雜訊切掉
  return t.replace(/[\s　「」『』【】（）()［］[\]|,.!?、，。！？：:；;\-—~…]/g, "").slice(0, 14);
}

function relevant(title: string, t: Topic) {
  if (!AI_RE.test(title)) return false;
  if (DENY.test(title)) return false;
  if (t.deny && t.deny.test(title)) return false;
  if (!t.must.test(title)) return false;
  if (t.needText && !TEXT_RE.test(title)) return false;
  return true;
}

function refine(items: Item[], t: Topic | null) {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const it of items) {
    if (t && !relevant(it.title, t)) continue;
    const k = dedupeKey(it.title);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// ── 快取 ────────────────────────────────────────────
// Edge Function 實例會被重用，冷啟動時是空的，抓一次就有。
const cache = new Map<string, { at: number; items: Item[]; filtered: boolean }>();

type Fetched = { items: Item[]; at: number; fresh: boolean; filtered: boolean };

async function fetchNews(query: string, topic: Topic | null): Promise<Fetched> {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < TTL) {
    return { items: hit.items, at: hit.at, fresh: false, filtered: hit.filtered };
  }

  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) +
    "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
  const res = await fetch(url, {
    headers: {
      // 不帶 UA 時 Google 偶爾回空的 feed
      "User-Agent": "Mozilla/5.0 (compatible; aisloptool-news/1.0)",
      "Accept": "application/rss+xml, application/xml, text/xml",
    },
  });
  if (!res.ok) {
    // 抓不到就退回舊快取（過期也比空白好）
    if (hit) return { items: hit.items, at: hit.at, fresh: false, filtered: hit.filtered };
    throw new Error("Google 新聞回 " + res.status);
  }

  const raw = parseRss(await res.text(), FETCH_N);
  let items = refine(raw, topic);
  let filtered = true;
  if (!items.length) {          // 過濾到一則不剩就退回只去重的版本
    items = refine(raw, null);
    filtered = false;
  }
  const at = Date.now();
  cache.set(query, { at, items, filtered });
  return { items, at, fresh: true, filtered };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json(405, { error: "只接受 GET" });

  const sp = new URL(req.url).searchParams;
  const rawQ = (sp.get("q") || "").trim();
  const topicKey = (sp.get("topic") || "").trim();
  let n = Number(sp.get("n") || DEFAULT_N);
  if (!Number.isFinite(n) || n < 1) n = DEFAULT_N;
  n = Math.min(Math.floor(n), MAX_N);

  let query: string, usedTopic: string, topic: Topic | null;
  if (rawQ) {
    // 自由關鍵字只去重，不套主題過濾
    if (rawQ.length > MAX_Q) return json(400, { error: `關鍵字最多 ${MAX_Q} 字` });
    query = rawQ;
    usedTopic = "";
    topic = null;
  } else {
    usedTopic = TOPICS[topicKey] ? topicKey : DEFAULT_TOPIC;
    topic = TOPICS[usedTopic];
    query = topic.q;
  }

  try {
    const { items, at, fresh, filtered } = await fetchNews(query, topic);
    return json(200, {
      topic: usedTopic,
      query,
      count: Math.min(items.length, n),
      items: items.slice(0, n),
      cachedAt: new Date(at).toISOString(),
      fresh,
      filtered,
    }, 300);
  } catch (e) {
    return json(502, { error: e instanceof Error ? e.message : "抓不到新聞" });
  }
});
