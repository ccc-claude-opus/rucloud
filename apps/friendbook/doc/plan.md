# friendbook 部署計畫

## 定位

類小紅書的社交網站：短筆記動態牆、按讚、留言、追蹤、熱門排行。
美術採 Threads 風格：黑白、系統字體、細分隔線、圓形頭像、圓角膠囊按鈕、單欄文字流。

## 技術選型（全 Cloudflare）

| 面向 | 服務 | 用途 |
|------|------|------|
| 程式 | Workers | `src/worker.js`，API + 靜態資產代理 |
| 使用者/內容 | D1 | users、posts、likes、comments、follows |
| 熱門路徑快取 | KV | 讚數快取（`like:{postId}`）、瀏覽數（`views:{postId}`）、當日熱門排行（`hot:{YYYYMMDD}`）、貼文圖片（`img:{key}`，5MB 內原樣二進位 + metadata 記 content-type） |
| 前端 | Workers Assets | `public/`，vanilla JS 單頁 |
| 認證 | HMAC session cookie | 與 myshop 相同：`userId.expiry.hmac`，PBKDF2 存密碼 |

KV 的理由：按讚與瀏覽數是最高頻、只需最終一致的數字，放 KV 免去每次 COUNT 查 D1；
熱門排行只保留前 20 名、當天有效，讀取完全不打 D1。

## 限制

* 圖片上傳有三個入口：發文視窗直接 ⌘V 剪貼簿貼圖、拖放、或點「🖼 圖片」選檔。上傳走 `POST /api/upload`，圖存 KV、用 `/img/{key}` 公開取回；key 以 `p{userId}-` 開頭，server 驗證屬主，只支援 jpeg/png/webp/gif、最大 5MB。之後量大可升級 R2（本帳號需先在 Dashboard 開通 R2 才能建 bucket）。
* 貼文上限 1000 字、留言 500 字；#標籤 最多 24 字。
* 熱門排行是「被按讚次數」，每天重置（以 UTC 日期為 key）。

## 部署步驟

```bash
cd friendbook
npm install
npx wrangler d1 create friendbook-db            # 把 database_id 填進 wrangler.jsonc
npx wrangler kv namespace create CACHE          # 把 id 填進 wrangler.jsonc 的 KV
npx wrangler d1 execute friendbook-db --remote --file=schema.sql
npx wrangler secret put AUTH_SECRET             # 亂數字串，登入 cookie 簽章用
npx wrangler deploy
```

## 本機測試

```bash
npx wrangler d1 execute friendbook-db --local --file=schema.sql
echo "AUTH_SECRET=dev-secret" > .dev.vars
npx wrangler dev
```

煙霧測試：`/api/signup` → `/api/posts` → `/api/feed` → `/api/posts/:id/like` → `/api/hot` → `/api/posts/:id/comments` → `/api/u/:name`；未登入的寫入操作應回 401。
