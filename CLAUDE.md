# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 協作規則

- **一律用繁體中文跟使用者對話。** 程式碼、指令、檔名、技術術語維持原文即可。
- **一次改動超過三個檔案，動手前先跟使用者說明範圍並取得同意。** 先列出預計會碰的檔案與原因，等點頭再改；三個以內照常直接做。

## 這是什麼

「校稿王」：貼上文字後用一組正則掃出中文 AI 腔用詞，再按一下交給 Claude 改寫的單頁工具。掃描純前端、離線可用；改寫、登入、方案、付款走 Supabase（Auth + Edge Functions + Postgres）。

`index.html` 就是整個前端——CSS、markup、規則、掃描、改寫、上傳檔案、路由全在同一個檔案裡（約 2200 行）。沒有 build、沒有 bundler、沒有 npm 相依、沒有測試框架。改完存檔重新整理瀏覽器就是全部的開發循環。後端在 `supabase/`：`functions/rewrite`（改寫）、`functions/title`（生成標題）、`functions/news`（AI 新聞）、`functions/ecpay`（綠界金流）、`migrations/`（profiles／usage／daily_usage／rewrites／orders）。

## 執行方式

```
# 最快：直接用瀏覽器開 index.html（file:// 就能跑，只有 PDF 輸出要走伺服器）

# 起本機伺服器（手機同網段測試用）
node _server.mjs            # http://localhost:8731，會自動開瀏覽器
```

`開啟去ai味小工具.bat` 是給非工程使用者的雙擊入口，會找到資料夾、檢查 node 存在、再跑 `_server.mjs`。

`_server.mjs` 只是個靜態檔案伺服器（固定 port 8731、`Cache-Control: no-store`、擋 `..` 跳出資料夾）。port 被占用時它不會報錯，而是判定「已經有一個在跑」，直接開瀏覽器後自行結束。

`file://` 直接開時掃描、改寫、Word 上傳都能跑，只有 **PDF 輸出**不行（`fetch` 抓不到 `assets/fonts/` 的字型），要走伺服器。

## 架構

資料流是 `render(raw)` → `scan(raw)` → 兩個輸出區（全文標記 + 命中清單），輸入框 200ms debounce 觸發。

理解 `scan()` 需要抓住幾個概念：

- **raw / plain**：偵測到 HTML 標籤才走 `toPlain()` 去標籤（區塊標籤換成 `\n`，讓標題自成一行）。所有位置索引都是相對 `plain`。
- **hits vs marks**：`hits` 是全部命中（清單全列）；`marks` 是實際在全文區畫底線的子集合。重疊的命中只有第一個能拿到 `<mark>`，被蓋掉的命中透過 `markIndex` 指向包住它的那個 mark，這樣點清單還是跳得到位置——**避免 `<mark>` 巢狀是這段設計的唯一理由**。
- **anchored**：命中位置是否對得上 `plain`。HTML 輸入下 `scope:"raw"` 的規則掃的是原始字串，位置對不上，所以 `anchored:false`，只列清單不標紅。
- **hard vs soft**：`soft` 命中（破折號、`從…到…`、`非常/相當/極為`）分開計數、用墨色虛線標，免得每篇都被破折號洗版、讓數字失去意義。

### 登入、方案、改寫

- 頁面全部公開，未登入也能掃描、看方案、看文章；只有改寫、上傳檔案、付款三個動作會呼叫 `gotoLogin()` 送去 `#login`（Google OAuth 或 Email 密碼），登入完由 `afterLogin()` 送回原本那頁（記在 sessionStorage，因為 OAuth 會整頁重載）。`route()` 是 hash 路由，頁面清單在 `PAGES`。
- 方案在 `profiles.plan`（free／paid）+ `paid_until`（null 是手動標記的永久付費）。免費版每月 `FREE_MONTHLY` 篇改寫，額度由 Edge Function 呼叫 `consume_quota()` 原子扣，**前端的 `FREE_MONTHLY` 要跟 `functions/rewrite/index.ts` 一致**。手動開通：`update public.profiles set plan = 'paid' where id = '<uuid>'`。
- 改寫流程 `runRewrite(paras, {source})`：文章先切段（`splitParas`，`i` 就是位置），再依 `CHUNK_CHARS` 分批打 `rewrite`，逐批回填左右對照區。`source` 是 `paste`／`docx`／`pdf`，後端看到 `docx`／`pdf` 且非付費直接 403。
- 前端用的是 publishable key，閘道層驗不了 JWT，所以 `config.toml` 把 `verify_jwt` 關掉、函式裡自己 `auth.getUser(token)`。

### 生成標題

「生成標題」按鈕跟「改寫」一排，把文章（`scan(raw).plain`，最多 `TITLE_MAX_CHARS` 字）丟給 Edge Function `title`，一次回五個候選標題，每種風格一個，點一列複製一個。

- **五種風格的名稱兩邊要一致**：後端 `STYLES`（直述、疑問、數字、痛點、故事）是唯一來源，`parseTitles()` 拿它對位、對不上的用剩下的標題補位，前端只是把回來的 `style` 畫出來。
- **額度是每日制，跟改寫的每月制分開**：`daily_usage (user_id, ymd, kind, n)`，kind 現在只有 `'title'`，以後別的每日限次功能可以沿用同一張表。原子扣用 `consume_daily()`，超過上限回 `-1` → 函式回 **429**。前端 `FREE_TITLE_DAILY` 要跟 `functions/title/index.ts` 一致（跟 `FREE_MONTHLY` 同一套規矩）。
- 日界線都是**台北時間**：後端 `to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM-DD')`，前端 `ymdTpe()` 用 `toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" })` 拿同格式的字串，不能改成本地時間。
- **額度是先扣再叫模型**，模型掛掉會 `refund_daily()` 退一次回去。一天只有三次，白扣很有感；改這段時別把退還拿掉。
- 429 畫面是 `#gate429` 遮罩卡片（`showGate()`），寫在 `<script>` 之前，**不能搬到 `</script>` 後面**，不然 `document.getElementById` 拿不到。

### AI 新聞

導覽列「AI新聞」（`#news`）是公開頁，跟 AI 知識一樣不用登入。Google 沒有新聞 API，`news.google.com/rss/search` 的 RSS 又擋 CORS，所以走 Edge Function `news` 代抓再轉 JSON；前端用 `fetch` 打 GET（不是 `sb.functions.invoke`，那個是 POST），帶 apikey header。

- 四個主題（去 AI 味／AI 寫作／抓包 AI／AI 與 SEO）的 key 兩邊要一致：前端 `NEWS_TOPICS`、後端 `TOPICS`。也吃 `?q=` 自由關鍵字（只去重，不套主題過濾）。
- **關聯度全靠 `TOPICS` 那三層，改查詢前先想過**：查詢一定要用引號片語（`"AI寫作"`），裸查詢 `AI 寫作 OR AI 文章` 會被「AI」單字洗版，回來一半是財經新聞；標題再過 `must`／`needText`／`deny` 與全域 `DENY`（股市題材、社會案件、工業檢測這些同字不同義的）；最後把多家轉載的同一則去重。過濾到空的會自動退回未過濾版本（`filtered:false`）。
- 函式裡記憶體快取 15 分鐘（Edge 實例重用時才有），Google 抓不到就退回舊快取；前端另外用 `newsCache` 記住這次造訪抓過的主題，切回去不重打。
- Edge Runtime 沒有 DOMParser，RSS 用字面正則逐個 `<item>` 撈。**別把正則改成 `new RegExp` 拼字串**，跳脫層數很容易寫錯（`\s` 少一層就變成字面 `s`，解析結果會靜默變成 0 筆）。

### 上傳檔案（付費版）

檔案全程在瀏覽器裡處理，只有文字段落離開電腦。程式在 `// ── 上傳檔案` 到 `// ── 上傳流程` 之間，函式庫（JSZip、pdf.js、pdf-lib、fontkit）只在真的丟檔案時才從 CDN 載。

- **docx**：JSZip 拆 `word/document.xml`，每個 `w:p` 底下的 `w:t`／`w:tab`／`w:br` 合成一段。寫回時挑「不在超連結裡、字數最多」的 `w:t` 當宿主、其他清空，段落樣式與宿主 run 的格式都留著；段內混合格式因此會統一成主要格式。只碰 `document.xml`，頁首頁尾、註腳不動。
- **pdf**：pdf.js 抽字 → `pdfLines()` 依 baseline 併行 → `pdfBlocks()` 依字級、水平重疊、行距併段（首行縮排、句號提早收尾視為新段）。寫回是 **蓋白再寫新字**，不是真的編輯：原字還在白框底下，有色背景會露白塊。新字塞不下先往下借空白（`room`），再每次縮 5% 到最小 75%，再不行就溢出並在狀態列提醒。
- **字型三個坑，改字型前先看**：
  1. fontkit 對 CID-keyed OTF（Noto CJK 原版）做 subset 會壞字，只能用 TrueType 外框；而且字形資料要 **4 bytes 對齊**，不然 loca 短格式除以 2 會錯位、一樣壞。`assets/fonts/NotoSansTC-Regular.woff` 是用 fontTools 定格 wght=400、subset 到 Big5+HKSCS、去 hinting、`glyf.padding = 4` 做出來的，來源與步驟寫在旁邊的 `OFL.txt`。
  2. fontkit 直接吃 WOFF 時每碰一個字形就把整個 glyf 表重新解壓一次（存一份 PDF 要 9 秒），所以 `loadFont()` 下載後先用 `DecompressionStream` 解成 TTF（`woffToTtf`）再交給它，0.3 秒。WOFF2 不行，fontkit 的 subset 讀不到它的 glyf。
  3. Chrome 印出來的 PDF 抽字會把「一、而、生」對到康熙部首碼位（U+2E80–2FDF），`pdfLines()` 逐字 NFKC 正規化回去。不能整串 NFKC，全形標點會被轉成半形。
- 量字寬走 `_charW` 逐字快取：GPOS 已拆掉所以寬度就是逐字相加，別改回逐段呼叫 `widthOfTextAtSize`（每次 ~10 ms）。

## 規則區塊

九成的修改都發生在 `<script>` 最上方 `===== 規則從這裡開始 =====` 到 `===== 規則到這裡結束 =====` 之間的 `RULES` 陣列（約 index.html:960-1020，不是在檔案最上面，規則前面還有 CSS 與 markup）。格式 `[正則, 類別, 說明, 選項]`：

- `scope`：`"text"`（預設，掃去標籤後的內文）／`"raw"`（掃原始輸入，例如抓 Markdown 殘留）／`"heading"`（只掃像標題的行：單獨成行、30 字內、結尾沒標點，或 `#` 開頭）
- `soft: true`：待確認，不一定要改

類別代號 `A`–`F` 加「風格」，`CAT_ORDER` 決定清單排序、`CAT_TONE` 決定徽章朱紅／墨色輪替。新增類別要同時改這兩個常數。

### 規則的上游

本檔的 RULES 是從 `D:\qkangber\scripts\check-ai-style.mjs` 移植的，真正的規則文件在 `D:\qkangber\docs\anti-ai-style.md`（唯一來源）。同步時注意這**不是純複製貼上**：

- 上游掃的是 HTML 原始碼，標題規則寫成 `/<h[23][^>]*>.../`；本檔掃的是去標籤後的文字，同一條要改寫成 `scope:"heading"` 的形式。
- 上游沒有 `soft` 概念，soft 標記是本檔獨有的。
- 兩邊目前已經有落差（上游 46 條 / 本檔 43 條），同步時以上游為準逐條比對，不要假設數量相同。

改動規則數量時，README.md 裡的「43 條正則」與類別表也要一起更新。

## 版面與插圖

漫畫分格風。`.slot` 容器的圖片都是 `<img ... onerror="this.remove()">` 搭配底層 `.slot-hint` 提示框——**圖檔不存在時 img 自我移除、露出網點底的提示，這是預期行為不是 bug**。`assets/portrait.png` 目前就沒有檔案。

字型從 Google Fonts 載入，離線時會退回 `--font-mincho` / `--font-ui` 裡的系統字型，功能不受影響。

## 注意事項

- `開啟去ai味小工具.bat` **必須維持純 ASCII**：cmd.exe 在 `chcp` 生效前會誤解非 ASCII 位元組，導致路徑與訊息壞掉。所有中文輸出都由 `_server.mjs` 印。`.gitattributes` 已把 `*.bat` 釘成 CRLF。
- Commit message 用中文（`feat: ...`）。
- `assets/fonts/NotoSansTC-Regular.woff` 是 OFL 授權的衍生字型，改動或換字型時 `OFL.txt` 的來源與修改說明要一起更新。
