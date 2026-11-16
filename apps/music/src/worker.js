// 練習成績 API：/api/progress 的讀寫，資料存 D1。
const json = (o, status = 200) => Response.json(o, { status });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/progress' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM progress ORDER BY updated_at DESC').all();
      return json({ rows: results });
    }

    if (url.pathname === '/api/progress' && request.method === 'POST') {
      const body = await request.json();
      const drill = String(body.drill || '').trim().slice(0, 40);
      const score = Math.max(0, Math.min(100, Number(body.score) | 0));
      if (!drill) return json({ error: '需要 drill' }, 400);
      await env.DB
        .prepare(
          `INSERT INTO progress (drill, best, plays, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(drill) DO UPDATE SET
             best = MAX(best, excluded.best), plays = plays + 1, updated_at = excluded.updated_at`,
        )
        .bind(drill, score, new Date().toISOString())
        .run();
      const best = await env.DB.prepare('SELECT best FROM progress WHERE drill = ?').bind(drill).first('best');
      return json({ ok: true, drill, best }, 201);
    }

    if (url.pathname === '/api/summary') {
      const row = await env.DB
        .prepare('SELECT COUNT(*) AS drills, COALESCE(SUM(plays), 0) AS plays FROM progress')
        .first();
      return json(row);
    }

    return env.ASSETS.fetch(request);
  },
};
