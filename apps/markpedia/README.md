# Markpedia

用 Markdown 寫的「維基百科式」知識庫，跑在 Cloudflare Workers 上。

* 每篇條目是一份 **GitHub Flavored Markdown** 原稿，存在 D1，
  支援表格、程式碼區塊、**KaTeX 數學**（前端渲染）與 **mermaid 圖表**
* 每個條目有 **繁體中文版（zh）** 與 **英文版（en）** 兩種語言版本，可切換
* 可新增、修改、刪除、搜尋（標題與全文 LIKE），另有隨機條目
* 前端用 marked + DOMPurify + KaTeX + mermaid（皆由 CDN 載入），渲染順序固定為
  GFM → mermaid → 數學，先把 mermaid 區塊搬走才掃數學

寫條目的慣例：**行內數學 `$...$` 的兩側要留一個空白**，GitHub 與本站才會正確
渲染；seed 條目全部符合這條規則，改動 seed 時也要維持。

## 檔案

```
src/worker.js     API：GET /api/entries、POST /api/entries、
                  GET/PUT/DELETE /api/entry/{slug}、GET /api/random
                  資料表是空的時候會從 public/seed/ 自動灌範例條目
public/           前端 SPA（hash 路由：#/ 入口頁、#/admin 管理員、
                  #/new、#/p/{slug}、#/edit/{slug}）
public/seed/      分類樹與條目的 zh+en 原始 Markdown（共 314 檔、157 個條目）
schema.sql        D1 結構（entries：slug+lang 複合主鍵）
```

## 分類樹

三層結構：九大學門 → 三十六個次分類 → 一百一十一個條目。

```
入口頁（#/，表格：天、地、文、法、商、理、工、醫、農）
  └─ 學門（cat-tian …）        #/p/cat-tian
       └─ 次分類（cat-astronomy …）   #/p/cat-astronomy
            └─ 條目（telescope …）   #/p/telescope
```

每個分類頁都是一則條目，內容是「下轄次分類」或「收錄條目」的表格，
每個條目頁的開頭都有回到上層的分類麵包屑。

| 層級 | 數量 | 例子 |
| --- | --- | --- |
| 學門 | 9 | `cat-tian`（天學門） |
| 次分類 | 36 | `cat-astronomy`（天文） |
| 條目 | 111 | `telescope`（望遠鏡） |

分類樹的定義同時出現在三處，改動時要一起改：
`src/worker.js` 的 `SEED` 陣列、`public/seed/` 下的 Markdown、
`public/app.js` 的 `PORTAL` 常數（入口頁表格）。

## 頁面

| 路由 | 內容 |
| --- | --- |
| `#/` | **入口頁**：九大學門與次分類的表格（天、地、文、法、商、理、工、醫、農） |
| `#/admin` | 管理員：全部條目清單（原本的首頁）與搜尋結果 |
| `#/p/{slug}` | 條目頁（zh/en 可切換） |
| `#/new`、`#/edit/{slug}` | 新增／編輯表單 |

## 本機開發

```bash
npm install        # 只在新機器或依賴改動時
npm run db         # 建立/更新本機 D1 表（首次）
npm run dev        # wrangler dev 於 http://localhost:8787
```

煙霧測試：

```bash
curl localhost:8787/api/entries                       # 應回 314 筆範例條目（157 個條目 × 2 語言）
curl 'localhost:8787/api/entry/markdown?lang=zh'      # 應回 Markdown 原稿 JSON
curl 'localhost:8787/api/entry/cat-tian'              # 應回學門頁（含下轄次分類表格）
curl 'localhost:8787/api/entry/telescope'             # 應回條目頁（含分類麵包屑）
curl -X POST localhost:8787/api/entries \
  -H 'Content-Type: application/json' \
  -d '{"slug":"t1","lang":"zh","title":"T","body":"B"}'   # 應回 201
curl -X DELETE localhost:8787/api/entry/t1              # 應回 {"deleted":1}
```

重灌範例條目（seed 只在資料表是空的時灌入）：

```bash
npx wrangler d1 execute markpedia-db --local --command "DELETE FROM entries"
```

## 用 rucloud 跑

```bash
rucloud dev . --d1-init DB=schema.sql   # http://localhost:8787
```

或在 rucloud repo 根目錄 `rucloud serve examples/rucloud.toml`（markpedia 在 http://localhost:8714）。
D1 的 seed 由 worker 自己在首次請求時灌入，不需要另外下 SQL。

seed 共 314 筆，因為免費方案的單一請求上限是 50 個 subrequest，
所以每次請求只灌一批（40 筆），靠後續請求接力灌完。
直接開某一條條目的網址時，worker 會把該條目排進這一批的最前面，
讀者不必等整批灌完就看得到內容。

`wrangler.jsonc` 裡的 `database_id` 是 Cloudflare 遠端 D1 的 id，本機跑不需要改。

## 部署

```bash
npx wrangler d1 create markpedia-db                  # 把輸出 id 填入 wrangler.jsonc
npm run db-remote                                    # 線上建表
npx wrangler deploy                                  # 上線（首次請求會自動灌範例）
```

線上版：<https://markpedia.ccckmit.workers.dev>

### 重新灌 seed（改了 public/seed/ 之後）

seed 只在資料表是空的時灌入，所以改了 `public/seed/` 要主動重灌。
條目多時不建議靠 worker 自己分批灌（每次請求 40 筆，314 筆要 8 個請求），
直接用 SQL 匯入更快也一次到位：

```bash
# 產生 INSERT 語句（用 hex 編碼帶入，避免 Markdown 裡的換行與引號破壞 SQL）
node -e "
const fs=require('fs');
const entries=JSON.parse(fs.readFileSync('/tmp/seed-list.json','utf8'));
const hex=(s)=>\"CAST(x'\"+Buffer.from(s,'utf8').toString('hex')+\"' AS TEXT)\";
const stmts=entries.map(e=>{
  const body=fs.readFileSync('public/seed/'+e.slug+'.'+e.lang+'.md','utf8');
  return 'INSERT INTO entries (slug, lang, title, body) VALUES (\''+e.slug+'\', \''+e.lang+'\', '+hex(e.title)+', '+hex(body)+');';
});
fs.writeFileSync('/tmp/seed.sql', stmts.join('\n')+'\n');
"
wrangler d1 execute markpedia-db --remote --command "DELETE FROM entries"
wrangler d1 execute markpedia-db --remote --file /tmp/seed.sql
```

匯入後確認筆數（應為 314 = 157 個條目 × 2 語言）：

```bash
wrangler d1 execute markpedia-db --remote --command "SELECT COUNT(*) AS n FROM entries"
```

沒有 secret：markpedia 不需要登入，任何打到 Workers 的人都能編輯（自用維基的定位）。
