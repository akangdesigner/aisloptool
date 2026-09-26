// 展示版的假後端：長得跟 supabase-js 一樣（window.supabase.createClient），
// 但登入、方案、額度、改寫、標題、新聞、小幫手、聯絡表單、付款全部在瀏覽器裡假裝，
// 資料存在 localStorage。沒有任何金鑰、沒有任何網路請求打到真的後端。
// 額度規則照正式版：免費每月改寫 5 篇、生成標題每天 3 次；付費不限。
(() => {
  const DEMO_URL = "https://demo.invalid";
  window.DEMO_BACKEND_URL = DEMO_URL;

  const FREE_MONTHLY = 5;
  const FREE_TITLE_DAILY = 3;
  const LS = "demo:";

  const load = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ymNow = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
  const ymdTpe = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });

  // ── 資料 ──────────────────────────────────────────
  const db = {
    profile: () => load("profile", { plan: "free", paid_until: null }),
    usage: () => (load("usage", {})[ymNow()] || 0),
    daily: () => (load("daily", {})[ymdTpe()] || 0),
    orders: () => load("orders", []),
  };
  function stillPaid() {
    const p = db.profile();
    return p.plan === "paid" && (!p.paid_until || new Date(p.paid_until) > new Date());
  }
  function bump(key, id) {
    const m = load(key, {});
    m[id] = (m[id] || 0) + 1;
    save(key, m);
    return m[id];
  }

  // ── 登入 ──────────────────────────────────────────
  const listeners = [];
  let session = load("session", null);
  function setSession(s, event) {
    session = s;
    save("session", s);
    for (const cb of listeners) setTimeout(() => cb(event, s), 0);
  }
  function makeSession(email) {
    return { access_token: "demo", user: { id: "demo-user", email: email || "demo@example.com" } };
  }

  const auth = {
    onAuthStateChange(cb) {
      listeners.push(cb);
      return { data: { subscription: { unsubscribe() { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } } } };
    },
    async getSession() { return { data: { session } }; },
    async signInWithOAuth() { await sleep(300); setSession(makeSession("demo@example.com"), "SIGNED_IN"); return { error: null }; },
    async signInWithPassword({ email }) { await sleep(300); setSession(makeSession(email), "SIGNED_IN"); return { error: null }; },
    async signOut() { setSession(null, "SIGNED_OUT"); return { error: null }; },
  };

  // ── 資料表查詢：只做到頁面用到的 select().eq().maybeSingle() ──
  function from(table) {
    const where = {};
    const q = {
      select() { return q; },
      eq(k, v) { where[k] = v; return q; },
      async maybeSingle() {
        if (!session) return { data: null, error: null };
        if (table === "profiles") return { data: db.profile(), error: null };
        if (table === "usage") return { data: { n: db.usage() }, error: null };
        if (table === "daily_usage") return { data: { n: db.daily() }, error: null };
        if (table === "orders") return { data: db.orders().find((o) => o.merchant_trade_no === where.merchant_trade_no) || null, error: null };
        return { data: null, error: null };
      },
    };
    return q;
  }

  // ── Edge Functions ─────────────────────────────────
  function fail(status, body) {
    return {
      data: null,
      error: { message: body.error, context: { status, json: async () => body } },
    };
  }

  // 改寫：拿規則抓到的詞做固定替換。真的版本是 Claude 整段重寫，這裡只求「看得出有改」。
  const FIXES = [
    [/讓我們深入(探討|挖掘|了解)?/g, "來看"],
    [/深入(探討|挖掘|了解)/g, "看看"],
    [/值得注意的是[，,]?/g, ""],
    [/必須記住/g, "記得"],
    [/(綜上所述|總而言之)[，,]?/g, "所以"],
    [/(先)?(誠實|老實|坦白)(講|說)[，,：:]?/g, ""],
    [/說(真的|實話)[，,：:]?/g, ""],
    [/(不得不說|不諱言)[，,：:]?/g, ""],
    [/(我|這篇文?章?|本文|接下來|下面)(會|將)(說|講|告訴|介紹|教你|帶你|分享|談談?)(你|大家)?/g, ""],
    [/帶你(一起)?(了解|看懂|搞懂|認識|走過|拆解)/g, "看"],
    [/(把)?話(講|說)在?前(面|頭)[，,：:]?/g, ""],
    [/舉個?[^，。！？]{0,8}(例子|案例|例來說)[，,：:]?/g, ""],
    [/比如說[，,]?/g, "像是"],
    [/一句話(講完|總結|概括)[：:]/g, ""],
    [/簡單(來說|講|說)[，：:]/g, ""],
    [/來(接|看)真的[，,：:。]?/g, ""],
    [/真正(好玩|有趣|精彩|厲害)的(才|就)(開始|來了)[，,。！]?/g, ""],
    [/好戲(才|就)?(在後頭|登場|開始)[，,。！]?/g, ""],
    [/至關重要/g, "很重要"],
    [/樞紐的/g, "核心的"],
    [/關鍵的一(環|步)/g, "其中一$1"],
    [/不可磨滅的?/g, ""],
    [/凸顯了/g, "讓人看到"],
    [/強調了/g, "說了"],
    [/(刺眼|觸目驚心|怵目驚心|血淋淋|發人深省|耐人尋味)的?/g, ""],
    [/懂的都懂[，,。]?/g, ""],
    [/接住(你|妳)的情緒/g, "聽$1說"],
    [/這不是[^，。！？]{0,20}，[^，。！？]{0,8}而是/g, "其實是"],
    [/不僅是[^，。！？]{0,20}，[^，。！？]{0,8}更是/g, "也是"],
    [/(閃得掉|躲得掉)/g, "避得開"],
    [/(躲不過|逃不掉)/g, "避不開"],
    [/根本不(在|是)(同一個|同一回|一回)/g, "不太一樣，"],
    [/出手/g, "動手"],
    [/——/g, "，"],
    [/燈塔/g, "例子"],
    [/見證/g, "看到"],
    [/文化遺產中心/g, "文化中心"],
    [/批評者認為/g, "反對的人說"],
    [/有人認為/g, "有些讀者說"],
    [/\*\*/g, ""],
    [/(?<!#)##(?!#)\s*/g, ""],
    [/自我的探索/g, "認識自己"],
    [/認同感的建構/g, "找到歸屬"],
    [/效率的提升/g, "做得更快"],
    [/價值的展現/g, "看出價值"],
    [/某個?(午後|夜晚|時刻)/g, "上週三下午"],
    [/大幅(提升|改善|增加|降低)/g, "明顯$1"],
    [/(非常|相當|極為)/g, "很"],
  ];
  function fakeRewrite(t) {
    let s = t;
    for (const [re, to] of FIXES) s = s.replace(re, to);
    return s
      .replace(/([，、])\1+/g, "$1")
      .replace(/，([。！？])/g, "$1")
      .replace(/^[\s，、：:]+/, "")
      .replace(/([。！？\n])[，、：:]+/g, "$1")
      .replace(/很很/g, "很");
  }

  async function rewrite(body) {
    if (!session) return fail(401, { error: "請先登入" });
    const paras = (body.paragraphs || []).filter((p) => p && typeof p.i === "number" && typeof p.t === "string" && p.t.trim());
    if (!paras.length) return fail(400, { error: "沒有段落" });
    const source = typeof body.source === "string" ? body.source : "paste";
    const plan = stillPaid() ? "paid" : "free";
    if ((source === "docx" || source === "pdf") && plan !== "paid") {
      return fail(403, { error: "上傳 Word／PDF 改完照原格式下載，是付費版功能。升級後就能用。", plan });
    }
    let remaining = null;
    if (plan === "free" && !body.part) {
      if (db.usage() >= FREE_MONTHLY) {
        return fail(429, { error: `免費版每月 ${FREE_MONTHLY} 篇，這個月用完了。下個月一號重算，或升級付費版不限次數。`, remaining: 0, plan });
      }
      remaining = FREE_MONTHLY - bump("usage", ymNow());
    }
    await sleep(500 + Math.min(1500, paras.length * 120));
    const out = paras.map((p) => ({ i: p.i, t: fakeRewrite(p.t) }));
    return { data: { paragraphs: out, missing: 0, plan, remaining, model: "demo" }, error: null };
  }

  // 標題：抓第一句當主題，五種風格各套一個模板
  // 主題優先用文章裡重複最多次的 2～4 字詞（越長越好），找不到才退回第一個子句。
  // 先把 AI 腔清掉，免得主題抓成「值得注意的是」
  const STOP = /[的是了在和與及也都就而我你他她它們這那有個一不很會要把被讓]/;
  function topicOf(text) {
    const clean = fakeRewrite(text);
    const count = new Map();
    for (const run of clean.match(/[一-鿿]{2,}/g) || []) {
      for (let n = 4; n >= 2; n--) {
        for (let i = 0; i + n <= run.length; i++) {
          const w = run.slice(i, i + n);
          if (STOP.test(w[0]) || STOP.test(w[n - 1])) continue;
          count.set(w, (count.get(w) || 0) + 1);
        }
      }
    }
    let best = "", score = 0;
    for (const [w, c] of count) {
      const s = c >= 2 ? c * w.length : 0;
      if (s > score) { best = w; score = s; }
    }
    if (best) return best;
    return topicOfClause(clean);
  }
  function topicOfClause(text) {
    const clauses = text.split(/[。！？\n，、：:；;]/)
      .map((s) => s.replace(/^[「『"'\s]+|[」』"'\s]+$/g, "").trim());
    let t = clauses.find((s) => s.length >= 4) || "";
    if (t.length > 14) t = t.slice(0, 14);
    return t || "這件事";
  }
  async function title(body) {
    if (!session) return fail(401, { error: "請先登入" });
    const plan = stillPaid() ? "paid" : "free";
    let remaining = null;
    if (plan === "free") {
      if (db.daily() >= FREE_TITLE_DAILY) {
        return fail(429, { error: `免費版每天可以生成 ${FREE_TITLE_DAILY} 次標題，今天用完了。明天再來，或升級付費版不限次數。`, remaining: 0, plan });
      }
      remaining = FREE_TITLE_DAILY - bump("daily", ymdTpe());
    }
    await sleep(700);
    const t = topicOf(String(body.text || ""));
    const titles = [
      { style: "直述", title: `${t}：做法與注意事項整理` },
      { style: "疑問", title: `${t}，到底該從哪裡開始？` },
      { style: "數字", title: `${t}的 5 個重點，第 3 個最常被忽略` },
      { style: "痛點", title: `還在為${t}卡關？先檢查這三件事` },
      { style: "故事", title: `我花了一個月處理${t}，結果跟想的不一樣` },
    ];
    return { data: { titles, plan, remaining, limit: FREE_TITLE_DAILY, model: "demo" }, error: null };
  }

  // 付款：不去綠界，直接開一張已付款的訂單、方案改成付費 30 天
  async function ecpayCreate(body) {
    if (!session) return fail(401, { error: "請先登入" });
    await sleep(600);
    const no = "DEMO" + Date.now().toString().slice(-10);
    const until = new Date(Date.now() + 30 * 86400000).toISOString();
    const orders = db.orders();
    orders.push({
      merchant_trade_no: no, status: "paid", email: body.email || session.user.email,
      rtn_code: "1", rtn_msg: "展示版模擬付款", simulated: true, paid_at: new Date().toISOString(),
    });
    save("orders", orders);
    save("profile", { plan: "paid", paid_until: until });
    return { data: { demo: true, orderNo: no }, error: null };
  }

  const functions = {
    async invoke(name, opts) {
      const body = (opts && opts.body) || {};
      if (name === "rewrite") return rewrite(body);
      if (name === "title") return title(body);
      if (name === "ecpay/create") return ecpayCreate(body);
      return fail(404, { error: "展示版沒有這個功能：" + name });
    },
  };

  window.supabase = { createClient: () => ({ auth, from, functions }) };

  // ── 走 fetch 的公開端點：新聞、小幫手、聯絡表單 ──────────
  const NEWS = {
    deslop: [
      "寫作者開始自己檢查 AI 腔用詞，常見的十個說法整理",
      "編輯台觀察：投稿裡「值得注意的是」一年多了三倍",
      "去 AI 味不是換同義詞，三位編輯分享實際改稿流程",
      "品牌文案退件原因調查：破折號與空泛形容詞名列前茅",
      "教育現場：老師怎麼跟學生說明 AI 寫作的語氣問題",
      "從句型下手：五種最容易被讀者認出的生成式文字",
    ],
    writing: [
      "內容團隊導入 AI 寫作工具半年，產量與改稿時間的變化",
      "自由接案者的新日常：先讓 AI 打草稿，再逐段重寫",
      "出版社訂出 AI 協作規範，要求標示使用範圍",
      "中文生成模型比較：長文連貫性與用詞自然度實測",
      "行銷人分享 AI 寫文案的三個工作習慣",
      "AI 寫作工具進入校園，寫作課怎麼調整評分方式",
    ],
    detect: [
      "AI 文字偵測工具準確度有限，研究建議不要單獨作為判斷依據",
      "大學調整作業規範：可以用 AI，但要附上修改紀錄",
      "讀者怎麼看出一篇文章是 AI 寫的？網路問卷結果出爐",
      "偵測工具誤判人類作品案例增加，校方重新檢視流程",
      "平台開始標示 AI 生成內容，創作者反應兩極",
      "非母語寫作者更容易被誤判為 AI，研究提出警告",
    ],
    seo: [
      "搜尋引擎更新說明：重點在內容是否有幫助，不在是否由 AI 產生",
      "網站主實測：大量 AI 文章上線後的流量變化",
      "AI 摘要出現在搜尋結果頂端，內容網站點擊率受影響",
      "SEO 顧問建議：AI 草稿要補上第一手經驗與實際數據",
      "生成式搜尋時代，品牌部落格該怎麼調整寫法",
      "內容農場式 AI 文章排名下滑，原創評測類內容回升",
    ],
  };
  function newsItems(topic) {
    const list = NEWS[topic] || NEWS.deslop;
    const now = Date.now();
    return list.map((title, k) => ({
      title,
      link: "https://news.google.com/search?hl=zh-TW&gl=TW&ceid=TW:zh-Hant&q=" + encodeURIComponent(title.slice(0, 12)),
      source: "展示用假新聞",
      date: new Date(now - (k * 29 + 3) * 3600000).toISOString(),
    }));
  }

  const BOT = [
    [/方案|價|錢|付費|訂閱|費用/, "免費版每月可以改寫 5 篇、每天生成標題 3 次；付費版月付 NT$180，不限次數，還能上傳 Word／PDF 改完照原格式下載。（展示版的付款是假的，按下去會直接開通。）"],
    [/上傳|word|pdf|檔案/i, "付費版可以上傳 Word（.docx）或 PDF，檔案在瀏覽器裡拆段落，只有文字送去改寫，改完照原本的格式讓你下載。"],
    [/掃描|怎麼用|規則|AI ?腔|AI ?味/i, "把文章貼進首頁的輸入框就會自動掃描，紅色底線是一定要改的 AI 腔用詞，墨色虛線是待確認（例如破折號）。點右邊清單可以跳到那個位置。"],
    [/登入|帳號|註冊/, "掃描不用登入；改寫、上傳檔案、付款才需要。展示版隨便填個信箱密碼就能登入。"],
    [/標題/, "貼好文章後按「生成標題」，會一次給你直述、疑問、數字、痛點、故事五種風格各一個，點一下就複製。"],
  ];
  function botReply(messages) {
    const last = (messages || []).slice(-1)[0];
    const q = (last && last.content) || "";
    for (const [re, a] of BOT) if (re.test(q)) return a;
    return "這是展示版，小幫手只會回固定的答案。可以問我方案、上傳檔案、掃描怎麼用、生成標題，或到「聯絡我們」直接寫信。";
  }

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!url.startsWith(DEMO_URL)) return realFetch(input, init);
    const u = new URL(url);
    const name = u.pathname.replace("/functions/v1/", "");
    await sleep(400);
    if (name === "news") {
      const topic = u.searchParams.get("topic") || "deslop";
      const items = newsItems(topic);
      return json(200, { topic, query: topic, count: items.length, items, cachedAt: new Date().toISOString(), fresh: true, filtered: true });
    }
    if (name === "chat") {
      let body = {};
      try { body = JSON.parse((init && init.body) || "{}"); } catch (e) {}
      return json(200, { reply: botReply(body.messages), model: "demo" });
    }
    if (name === "contact") return json(200, { ok: true });
    return json(404, { error: "展示版沒有這個端點" });
  };
})();
