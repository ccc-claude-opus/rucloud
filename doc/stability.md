# 穩定性承諾

rucloud 從 1.0.0 開始遵守 [語意化版本](https://semver.org/lang/zh-TW/)：

| 版本 | 可能的改動 |
|---|---|
| 1.x.**y**（修補） | 修正錯誤、效能改善、文件 |
| 1.**x**.0（次版） | 新功能、新的設定欄位與指令；舊的設定與指令照常可用 |
| **2**.0.0（主版） | 不相容的改動；會在 CHANGELOG 寫清楚怎麼升級 |

## 承諾不會在 1.x 內被破壞的

| 項目 | 範圍 |
|---|---|
| `rucloud.toml` | 所有欄位的名稱、意義與預設值（見 [deploy.md](deploy.md)）。新增欄位一定有預設值，舊設定不用改 |
| 指令 | 所有子指令、參數名稱與它們的行為；`rucloud check` 的結束碼（有錯誤是 1） |
| 管理埠 API | `/health`、`/metrics` 的指標名稱與標籤、`/apps/…`、`/analytics/sql`、`/queues/…` 的路徑、參數與回應格式 |
| S3 相容 API | 已支援的操作與 SigV4 驗證方式 |
| Worker 看到的行為 | 已支援的綁定 API（[bindings.md](bindings.md)）、`request.url`、`cf-cache-status` 等標頭 |
| 資料資料夾（`state_dir`） | 1.0 寫下的資料，之後的 1.x 都讀得懂；格式有變時啟動會自動轉換。資料夾裡的 `VERSION` 記錄格式版本，比目前 rucloud 新的資料會拒絕啟動，不會被舊版弄壞 |
| 支援的 Node.js | 1.x 期間至少支援 Node.js 22.15 與 24 |

## 不在承諾範圍內的

* **rucloud 內部的介面**：Rust 和 Worker 程序之間的綁定 API（`/b/…`）、`<state>/runtime/` 裡的 JS 檔、`RUCLOUD_SPEC` 的內容。
* **log 的文字內容**：給人看的訊息可能改寫；需要程式解析請用 `rucloud tail --json` 或 `/apps/<應用>/logs`（欄位 `ts`、`app`、`kind`、`message` 是穩定的）。
* **還沒支援的 Cloudflare 功能**：之後補上時行為可能和現在「被忽略」不同（例如 `compatibility_flags`）。`rucloud check` 會列出目前被忽略的 wrangler 欄位。
* **效能數字**：只會變好，但不承諾具體數值。
* Rust 的 crate API：rucloud 是執行檔，沒有對外的 Rust 函式庫介面。

## 設定檔的嚴格檢查

`rucloud.toml` 從 1.0 開始**不接受不認識的欄位**（打錯字會直接報錯，例如 `instnaces`），避免設定沒生效卻沒發現。`wrangler.jsonc` / `wrangler.toml` 則照舊寬鬆，因為裡面有很多 Cloudflare 才用得到的欄位；rucloud 不支援、但會影響行為的欄位，啟動時與 `rucloud check` 都會提醒。

## 回報問題

相容性問題（升級後舊設定不能用、資料讀不到）請在 GitHub 開 issue，附上 `rucloud --version`、`rucloud check` 的輸出與 CHANGELOG 中相關的版本。
