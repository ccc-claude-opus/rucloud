// 待辦清單 API：GET/POST /api/todos、PUT/DELETE /api/todos/:id
const json = (o, status = 200) => Response.json(o, { status });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/todos(?:\/(\d+))?$/);
    if (!m) return json({ error: 'not found' }, 404);
    const id = m[1] && Number(m[1]);
    const db = env.DB;
    if (request.method === 'GET' && !id) {
      return json((await db.prepare('SELECT * FROM todos ORDER BY id DESC').all()).results);
    }
    if (request.method === 'POST' && !id) {
      const { text } = await request.json();
      if (!String(text || '').trim()) return json({ error: '內容不能是空的' }, 400);
      const row = await db.prepare('INSERT INTO todos (text) VALUES (?) RETURNING *').bind(String(text).trim()).first();
      return json(row, 201);
    }
    if (request.method === 'PUT' && id) {
      const { done } = await request.json();
      await db.prepare('UPDATE todos SET done = ? WHERE id = ?').bind(done ? 1 : 0, id).run();
      return json({ ok: true });
    }
    if (request.method === 'DELETE' && id) {
      await db.prepare('DELETE FROM todos WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
    return json({ error: 'method not allowed' }, 405);
  },
};
