# map — Leaflet 釘選地圖

用 [Leaflet](https://leafletjs.com/) + OpenStreetMap 做的釘選地圖：點地圖任何位置就能新增釘選，資料存在 D1。

## 跑起來

```bash
rucloud dev examples/map --d1-init DB=schema.sql   # http://localhost:8787
```

或跟其他範例一起跑：

```bash
rucloud serve examples/rucloud.toml                # http://localhost:8715
```

## 內容

- `public/index.html` + `public/app.js` — Leaflet UI（CDN 載入），點地圖新增、點列表定位、popup 刪除
- `src/worker.js` — `/api/markers` CRUD 與 `/api/stats`，D1 綁定；第一次拜訪會自動塞三個示範釘選
- `schema.sql` — `markers` 資料表
