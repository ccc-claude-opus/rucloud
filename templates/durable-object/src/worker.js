// GET /<名稱>         目前的值
// POST /<名稱>        加一
// 同一個名稱永遠是同一個物件，並行的請求也不會算錯
import { DurableObject } from 'cloudflare:workers';

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hits (at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  }
  count() {
    return this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM hits').one().n;
  }
  increment() {
    this.ctx.storage.sql.exec('INSERT INTO hits DEFAULT VALUES');
    return this.count();
  }
}

export default {
  async fetch(request, env) {
    const name = new URL(request.url).pathname.slice(1) || 'default';
    const stub = env.COUNTERS.getByName(name);
    const value = request.method === 'POST' ? await stub.increment() : await stub.count();
    return Response.json({ name, value });
  },
};
