import { DurableObject } from 'cloudflare:workers';
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT, data BLOB);
        CREATE TABLE IF NOT EXISTS log (n INTEGER);
        CREATE TRIGGER IF NOT EXISTS t1 AFTER INSERT ON notes BEGIN INSERT INTO log VALUES (new.id); END;`);
    });
  }
  run() {
    const sql = this.ctx.storage.sql;
    const out = {};
    const ins = sql.exec('INSERT INTO notes (text, data) VALUES (?, ?)', 'a;b', new Uint8Array([1, 2]));
    out.insertWritten = ins.rowsWritten;
    out.ret = sql.exec("INSERT INTO notes (text) VALUES ('c') RETURNING id, text").one();
    const cur = sql.exec('SELECT id, text, data FROM notes ORDER BY id');
    out.cols = cur.columnNames;
    out.rows = cur.toArray().map((r) => ({ ...r, data: r.data ? [...new Uint8Array(r.data)] : null }));
    out.raw = [...sql.exec('SELECT id, id FROM notes').raw()];
    out.log = sql.exec('SELECT COUNT(*) AS n FROM log').one().n;
    try { sql.exec('SELECT * FROM notes').one(); } catch (e) { out.oneErr = e.message.slice(0, 30); }
    try { this.ctx.storage.transactionSync(() => { sql.exec("INSERT INTO notes (text) VALUES ('rolled')"); throw new Error('x'); }); } catch {}
    out.afterRollback = sql.exec("SELECT COUNT(*) AS n FROM notes WHERE text = 'rolled'").one().n;
    this.ctx.storage.kv.put('k', { d: new Date(0) });
    out.kv = this.ctx.storage.kv.get('k').d instanceof Date;
    out.size = sql.databaseSize > 0;
    return out;
  }
  async asyncKv() {
    await this.ctx.storage.put({ a: 1, b: 2 });
    const m = await this.ctx.storage.list({ prefix: '' });
    return [...m.keys()];
  }
  async wipe() { await this.ctx.storage.deleteAll(); return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'notes'").one().n; }
}
export class Old extends DurableObject { trySql() { try { this.ctx.storage.sql; return 'no error'; } catch (e) { return e.message.slice(0, 40); } } }
export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname !== '/') return new Response('ok');
    const s = env.DB.getByName('x');
    return Response.json({ run: await s.run(), kv: await s.asyncKv(), old: await env.OLD.getByName('y').trySql(), wipe: await s.wipe() });
  },
};
