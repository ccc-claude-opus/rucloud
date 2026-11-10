# music — 琴鍵實驗室（樂理 · 彈琴 · MIDI）

單檔式的音樂學習應用（改自靜態版「琴鍵實驗室」），加上 rucloud 的 D1 成績保存。亮／暗主題、手機可多指彈奏。

## 跑起來

```bash
rucloud dev examples/music --d1-init DB=schema.sql   # http://localhost:8787
```

或跟其他範例一起跑：

```bash
rucloud serve examples/rucloud.toml                  # http://localhost:8716
```

## 內容

- **🎹 琴鍵** — 三個八度（C3–C6）可橫向捲動：滑鼠多指、電腦鍵盤（`A–;` 白鍵、`W E T Y U O P` 黑鍵、`Z`/`X` 切八度）、**Web MIDI 實體鍵盤**（含指令即時解碼器）。按住的音會即時顯示音名、頻率、**和弦名稱**與**音程**
- **自由彈奏 / 音階與和弦** — 6 種音階、9 種和弦任選根音，琴鍵上色塊標示（根音深色）、逐音或同時播放
- **🎵 跟著彈** — 小星星、歡樂頌、生日快樂、給愛麗絲；下一音黃框提示，計時、錯誤計數、**星級評價存 D1**
- **👂 聽力訓練** — 音程（入門 4 種 → 全部 12 種）與和弦聽辨，每 10 題一回合，**回合分數存 D1**
- **樂理與 MIDI** — 音名/半音、音階公式、音程表、和弦、**SVG 五度圈**、節拍器（40–200 BPM）、MIDI 指令解說
- 琴鍵標籤：音名 / 唱名 / **簡譜** 三種切換

## 檔案

- `public/index.html` — 整個前端（單檔，Web Audio 合成音色，零依賴）
- `src/worker.js` — `/api/progress` 成績 CRUD（D1 upsert 取最佳）與 `/api/summary`
- `schema.sql` — `progress` 資料表
