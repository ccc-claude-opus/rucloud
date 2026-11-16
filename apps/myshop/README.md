# MyShop 個人商店（POS）

* 線上使用 -- https://myshop.ccckmit.workers.dev

任何人都能註冊帳號、挑一個開店模板（珍珠奶茶、理髮、雜貨、咖啡），馬上得到一套簡單的 POS：點單、看訂單、每日結算報表、管理商品。**沒有金流**——交易只記錄在資料庫。

| 畫面 | 功能 |
|---|---|
| 登入 / 註冊 | email + 密碼（PBKDF2 雜湊），HMAC 簽章 cookie 登入 |
| 開店 | 店名 + 模板；商品依模板自動建立 |
| 點單（POS） | 商品格點 → 購物車 → 完成交易（價格以資料庫為準） |
| 訂單 | 依日期列出當日每筆交易與明細 |
| 報表 | 每日結算：筆數、總額、平均、各商品數量與金額 |
| 商品 | 新增 / 刪除（軟刪除，舊訂單的快照不受影響） |

## 部署

```bash
cd myshop
npm install
npx wrangler d1 create myshop-db                    # 把印出的 database_id 填進 wrangler.jsonc
npx wrangler d1 execute myshop-db --remote --file=schema.sql
npx wrangler secret put AUTH_SECRET                 # openssl rand -hex 32
npx wrangler deploy
```

本機測試：

```bash
npm run db          # 本機建立資料表
npm run dev         # .dev.vars 需有 AUTH_SECRET=...（隨機字串即可）
```

## 檔案

| 檔案 | 說明 |
|---|---|
| `schema.sql` | D1 資料表：users、shops、products、orders、order_items |
| `src/worker.js` | 帳號（signup/login/logout）、商店、商品、訂單與報表 API |
| `src/templates.js` | 四個開店模板的商品清單 |
| `public/` | 前端：單頁應用（登入 → 開店 → POS） |

## 設計重點

* **session 是簽章 cookie**（`userId.expiry.hmac`），不查資料庫；金鑰放在 Worker secret `AUTH_SECRET`。
* **交易快照**：訂單明細記錄當下的商品名稱與價格，之後改價、刪商品不影響舊訂單；商品刪除是軟刪除。
* **價格由伺服器計算**：前端只送 productId 與數量，防篡改。
* **日期以使用者當地為準**：前端送出交易時帶本地日期（YYYY-MM-DD），報表以此結算（跨時區的使用者各自看自己的「今天」）。
* **資料庫**：Cloudflare D1（SQLite），一個使用者一間店。

相關文件見 `../doc/`。

## 用 rucloud 跑

```bash
cp .dev.vars.example .dev.vars        # 設定 AUTH_SECRET
rucloud dev . --d1-init DB=schema.sql # http://localhost:8787
```

或在 rucloud repo 根目錄 `rucloud serve examples/rucloud.toml`（myshop 在 http://localhost:8711）。
