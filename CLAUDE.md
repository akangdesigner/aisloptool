# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 協作規則

- **一律用繁體中文跟使用者對話。** 程式碼、指令、檔名、技術術語維持原文即可。
- **一次改動超過三個檔案，動手前先跟使用者說明範圍並取得同意。** 先列出預計會碰的檔案與原因，等點頭再改；三個以內照常直接做。

## 這是什麼

「去 AI 味檢查」：貼上文字後用一組正則掃出中文 AI 腔用詞的單頁工具。純前端、零相依、離線可用，不上傳、不呼叫 API、不改字，只標出命中處。

`index.html` 就是整個應用程式——CSS、markup、規則、掃描邏輯全在同一個檔案裡（約 540 行）。沒有 build、沒有 bundler、沒有 npm 相依、沒有測試框架。改完存檔重新整理瀏覽器就是全部的開發循環。

## 執行方式

```
# 最快：直接用瀏覽器開 index.html（file:// 就能跑，功能不打折）

# 起本機伺服器（手機同網段測試用）
node _server.mjs            # http://localhost:8731，會自動開瀏覽器
```

`開啟去ai味小工具.bat` 是給非工程使用者的雙擊入口，會找到資料夾、檢查 node 存在、再跑 `_server.mjs`。

`_server.mjs` 只是個靜態檔案伺服器（固定 port 8731、`Cache-Control: no-store`、擋 `..` 跳出資料夾）。port 被占用時它不會報錯，而是判定「已經有一個在跑」，直接開瀏覽器後自行結束。

## 架構

資料流是 `render(raw)` → `scan(raw)` → 兩個輸出區（全文標記 + 命中清單），輸入框 200ms debounce 觸發。

理解 `scan()` 需要抓住幾個概念：

- **raw / plain**：偵測到 HTML 標籤才走 `toPlain()` 去標籤（區塊標籤換成 `\n`，讓標題自成一行）。所有位置索引都是相對 `plain`。
- **hits vs marks**：`hits` 是全部命中（清單全列）；`marks` 是實際在全文區畫底線的子集合。重疊的命中只有第一個能拿到 `<mark>`，被蓋掉的命中透過 `markIndex` 指向包住它的那個 mark，這樣點清單還是跳得到位置——**避免 `<mark>` 巢狀是這段設計的唯一理由**。
- **anchored**：命中位置是否對得上 `plain`。HTML 輸入下 `scope:"raw"` 的規則掃的是原始字串，位置對不上，所以 `anchored:false`，只列清單不標紅。
- **hard vs soft**：`soft` 命中（破折號、`從…到…`、`非常/相當/極為`）分開計數、用墨色虛線標，免得每篇都被破折號洗版、讓數字失去意義。

## 規則區塊

九成的修改都發生在 `<script>` 最上方 `===== 規則從這裡開始 =====` 到 `===== 規則到這裡結束 =====` 之間的 `RULES` 陣列（約 index.html:265-317）。格式 `[正則, 類別, 說明, 選項]`：

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
