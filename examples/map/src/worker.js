// 釘選地圖 API：/api/markers 的 CRUD，資料存 D1。
const json = (o, status = 200) => Response.json(o, { status });

// 第一次拜訪時塞幾個示範釘選
const SEED = [
  { lat: 25.0338, lng: 121.5645, title: '台北 101', note: '地標' },
  { lat: 25.0478, lng: 121.5170, title: '台北車站', note: '交通樞紐' },
  { lat: 25.0330, lng: 121.5654, title: '四四南村', note: '眷村咖啡' },
];

async function seed(env) {
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM markers').first();
  if (n > 0) return;
  await env.DB.batch(
    SEED.map((m) =>
      env.DB
        .prepare('INSERT INTO markers (lat, lng, title, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(m.lat, m.lng, m.title, m.note, new Date().toISOString()),
    ),
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/api/markers' && request.method === 'GET') {
      await seed(env);
      const { results } = await env.DB.prepare(
        'SELECT * FROM markers ORDER BY id DESC LIMIT 500',
      ).all();
      return json({ markers: results });
    }

    if (p === '/api/markers' && request.method === 'POST') {
      const body = await request.json();
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      const title = String(body.title || '').trim().slice(0, 100);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !title)
        return json({ error: '需要 lat、lng、title' }, 400);
      const note = String(body.note || '').trim().slice(0, 500);
      const r = await env.DB
        .prepare('INSERT INTO markers (lat, lng, title, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(lat, lng, title, note, new Date().toISOString())
        .run();
      return json({ id: r.meta.last_row_id, lat, lng, title, note }, 201);
    }

    const m = p.match(/^\/api\/markers\/(\d+)$/);
    if (m && request.method === 'DELETE') {
      const r = await env.DB.prepare('DELETE FROM markers WHERE id = ?').bind(Number(m[1])).run();
      return json({ deleted: r.meta.changes });
    }

    if (p === '/api/stats') {
      await seed(env);
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS total, ROUND(MIN(lat), 4) AS minLat, ROUND(MAX(lat), 4) AS maxLat, ROUND(MIN(lng), 4) AS minLng, ROUND(MAX(lng), 4) AS maxLng FROM markers",
      ).first();
      return json(row);
    }

    return env.ASSETS.fetch(request);
  },
};
