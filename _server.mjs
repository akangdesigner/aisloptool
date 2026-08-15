// 去 AI 味小工具的本機伺服器。由桌面的「開啟去ai味小工具.bat」啟動。
// 只讀取本資料夾內的檔案，不對外寫入任何東西。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8731;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function openBrowser(url) {
  try {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* 開不起來就算了，網址已經印在畫面上 */
  }
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (rel === "/" || rel.endsWith("/")) rel += "index.html";

  // 防止跳出資料夾
  const target = path.join(ROOT, path.normalize(rel).replace(/^([\\/]|\.\.)+/, ""));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("找不到：" + rel);
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // 已經有一個在跑了，不用再開一個，直接把瀏覽器叫出來
    console.log("伺服器已經在跑了（port " + PORT + "），直接開瀏覽器。");
    console.log("這個視窗可以關掉，原本那個黑視窗才是伺服器。");
    openBrowser("http://localhost:" + PORT + "/");
    setTimeout(() => process.exit(0), 1200);
    return;
  }
  console.error("啟動失敗：" + err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  const lan = lanAddress();
  console.log("");
  console.log("  去 AI 味小工具已啟動");
  console.log("  ─────────────────────────────────────────");
  console.log("  這台電腦   http://localhost:" + PORT + "/");
  if (lan) console.log("  同網路手機 http://" + lan + ":" + PORT + "/");
  console.log("  ─────────────────────────────────────────");
  console.log("  關掉這個黑視窗就會停止。");
  console.log("");
  openBrowser("http://localhost:" + PORT + "/");
});
