# friendbook

類小紅書的社交網站：短筆記、按讚、留言、追蹤、熱門排行，美術是 Threads 風格（黑白、細分隔線、圓頭像）。

## 使用

```bash
npm install
npx wrangler d1 execute friendbook-db --local --file=schema.sql   # 本機建表
npx wrangler dev                                                  # http://localhost:8787
```

部署前要設定 D1 database_id、KV namespace id、`AUTH_SECRET` secret，詳見 [doc/plan.md](doc/plan.md)。


## 用 rucloud 跑

```bash
cp .dev.vars.example .dev.vars        # 設定 AUTH_SECRET
rucloud dev . --d1-init DB=schema.sql # http://localhost:8787
```

或在 rucloud repo 根目錄 `rucloud serve examples/rucloud.toml`（friendbook 在 http://localhost:8712）。

## 架構

* `src/worker.js` — Worker：API（`/api/*`）+ 靜態資產
* `public/` — 前端（vanilla JS 單頁）
* `schema.sql` — D1 表結構
* KV：讚數／瀏覽數快取、當日熱門排行（`hot:{YYYYMMDD}`）

訪客不需登入就能逛動態牆、貼文與個人頁；發文、按讚、留言、追蹤要登入。
