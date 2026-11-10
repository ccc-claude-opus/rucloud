# boardgame — 棋藝軒（經典棋類與桌遊對戰平台）

移植自 AI Studio 的 `boardgame-arena`（原本是 Express + `ws` 的 Node 伺服器，狀態全放記憶體），
改成 rucloud / Cloudflare Workers 架構：

- **前端**：React + Tailwind（Vite build），象棋、五子棋、西洋棋、跳棋、大富翁，
  遊戲邏輯全在瀏覽器端（AI 對手也是前端自己算）。
- **後端**：`src/worker.js` 一支 Worker + 一個 SQLite 型 Durable Object（`Arena`），
  WebSocket 用 hibernation API。原本 in-memory 的房間、聊天室、ELO 排行改成存
  `ctx.storage.sql`，程序重開或 DO 休眠後狀態不會消失。

## 跑起來

public/ 已含 build 好的前端，直接跑即可：

```bash
rucloud dev examples/boardgame    # http://localhost:8787
```

或跟其他範例一起跑：

```bash
rucloud serve examples/rucloud.toml   # http://localhost:8718
```

要改前端時再重新 build：

```bash
cd examples/boardgame
npm install
npm run build   # vite build → public/
npm run check   # tsc --noEmit
```

## 功能

- **大廳** — 五種遊戲卡片，一鍵開「人機對戰」或「雙人連線」房
- **對戰室** — 走子即時同步（p1/p2/觀戰者）、重開一局、音效開關
- **即時賽況** — 所有房間的回合數與狀態，可點「觀戰」同步看棋盤
- **聊天室** — 全域頻道＋房間頻道，保留最近 60 則
- **積分排行** — ELO（K=32）自動結算，勝/敗/和與擅長項目

## 訊息協定（`/ws`）

客户端 → 服務端：`player:identify`、`room:create`、`room:join`、`room:spectate`、
`room:leave`、`room:move`、`room:reset`、`chat:send`。
服務端 → 客户端：`init`、`rooms:update`、`room:joined`、`room:state`、
`leaderboard:update`、`chat:message`。

## 檔案

- `src/worker.js` — `Arena` Durable Object（房間 / 聊天 / ELO，SQLite storage）＋ `/ws` 路由
- `src/`、`index.html`、`vite.config.ts` — React 前端原始碼
- `public/` — Vite build 產物（靜態資產，已含最新 build）
- `wrangler.jsonc` — assets + Durable Object 綁定與 migration
