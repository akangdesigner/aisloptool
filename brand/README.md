# 校稿王 — Logo 素材包

## 檔案

- `mark/mark-512.png`（256 / 128 / 64 / 32）— 日輪筆尖章，方形、去背、居中，留 6% 邊距。app icon、favicon、頭像用。
- `lockup/lockup-horizontal.png` — 章在左、字標在右，橫式。網頁刊頭用。
- `lockup/lockup-stacked.png` — 章在上、字標在下，直式。去背。
- `lockup/lockup-stacked-on-paper.png` — 直式壓在紙色 #efe9dd 上，交付與簡報用。
- `lockup/lockup-stacked-on-ink.png` — 直式壓在墨色 #17150f 上（檢查用：筆尖鏤空會透出底色）。
- `wordmark/wordmark.png` — 只有「校稿王」字標，去背。

原圖：`assets/logo-src.png`（含紙底），去背版 `assets/logo-transparent.png`。

## 顏色

| 用途 | 色值 |
| --- | --- |
| 朱紅（日輪） | `#c0392b` |
| 墨（筆尖、字標） | `#17150f` |
| 紙（背景） | `#efe9dd` |
| 面板 | `#faf7f0` |
| 分隔線 | `#b9b1a1` |

## 用法

- 最小顯示高度：章 24px、橫式 lockup 32px。
- 淨空區：不小於章的直徑 25%。
- 去背版的筆尖內側是鏤空，壓深色底會透出底色。需要白色筆尖時用 `-on-paper` 版或自行墊一層 #efe9dd。
- 不要加漸層、陰影、發光、外框、圓角，不要旋轉超過 3 度，不要改色。
- 字標字體是明朝體（Zen Old Mincho 系），不要用其他字體重打。

## HTML 用例

```html
<img src="brand/lockup/lockup-horizontal.png" alt="校稿王" style="height:44px;width:auto">
<link rel="icon" href="brand/mark/mark-64.png">
```
