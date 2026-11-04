// rucloud 的綁定示範。每個 /api/<名稱> 示範一種綁定，回傳 JSON。
import { DurableObject } from 'cloudflare:workers';

// Durable Object：強一致的計數器（同一個名稱永遠是同一個實例）
export class Counter extends DurableObject {
  async increment(by = 1) {
    const n = ((await this.ctx.storage.get('n')) || 0) + by;
    await this.ctx.storage.put('n', n);
    return n;
  }
  async fetch(request) {
    return Response.json({ n: (await this.ctx.storage.get('n')) || 0, url: request.url });
  }
  async alarm() {
    await this.ctx.storage.put('alarmed', Date.now());
  }
}

const json = (o, status = 200) => Response.json(o, { status });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/api/vars') return json({ greeting: env.GREETING });

    if (p === '/api/d1') {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, at TEXT)');
      await env.DB.prepare('INSERT INTO hits (at) VALUES (?)').bind(new Date().toISOString()).run();
      return json({ hits: await env.DB.prepare('SELECT COUNT(*) AS n FROM hits').first('n') });
    }

    if (p === '/api/kv') {
      const n = Number((await env.KV.get('visits')) || 0) + 1;
      await env.KV.put('visits', String(n), { metadata: { by: 'showcase' } });
      return json({ visits: n, list: await env.KV.list({ prefix: 'vis' }) });
    }

    if (p === '/api/r2' && request.method === 'PUT') {
      const obj = await env.FILES.put(url.searchParams.get('key'), request.body, {
        httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' },
      });
      return json({ key: obj.key, size: obj.size, etag: obj.etag });
    }
    if (p === '/api/r2' && request.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!key) return json(await env.FILES.list());
      const obj = await env.FILES.get(key);
      if (!obj) return json({ error: 'not found' }, 404);
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      return new Response(obj.body, { headers });
    }

    if (p === '/api/r2-multipart') {
      const up = await env.FILES.createMultipartUpload('big.bin', { httpMetadata: { contentType: 'application/octet-stream' } });
      const part = new Uint8Array(5 * 1024 * 1024).fill(7);
      const p1 = await up.uploadPart(1, part);
      const p2 = await up.uploadPart(2, 'tail');
      const obj = await up.complete([p1, p2]);
      return json({ key: obj.key, size: obj.size, etag: obj.etag });
    }

    if (p === '/api/queue') {
      await env.JOBS.send({ task: 'thumbnail', at: new Date() });
      return json({ queued: true, done: Number((await env.KV.get('jobs-done')) || 0) });
    }

    if (p === '/api/do') {
      const stub = env.COUNTER.getByName(url.searchParams.get('name') || 'global');
      const n = await stub.increment(1);
      const viaFetch = await (await stub.fetch('https://do/count')).json();
      return json({ n, viaFetch });
    }

    if (p === '/api/vectors') {
      await env.VECTORS.upsert([
        { id: 'cat', values: [1, 0, 0], metadata: { kind: 'animal' } },
        { id: 'dog', values: [0.9, 0.1, 0], metadata: { kind: 'animal' } },
        { id: 'car', values: [0, 0, 1], metadata: { kind: 'vehicle' } },
      ]);
      return json(await env.VECTORS.query([1, 0, 0], { topK: 2, returnMetadata: 'all' }));
    }

    if (p === '/api/limit') {
      const { success } = await env.LIMITER.limit({ key: request.headers.get('cf-connecting-ip') });
      return success ? json({ ok: true }) : json({ error: '太多請求' }, 429);
    }

    if (p === '/api/hello') return env.HELLO.fetch('https://hello.internal/greet');

    if (p === '/api/cron') return json({ lastCron: await env.KV.get('last-cron') });

    // HTMLRewriter：拿靜態的 index.html，改標題、插一段計數
    if (p === '/api/page') {
      const page = await env.ASSETS.fetch(new Request(new URL('/index.html', url)));
      const visits = Number((await env.KV.get('visits')) || 0);
      return new HTMLRewriter()
        .on('h1', { element(el) { el.setInnerContent(`rucloud showcase（第 ${visits} 次造訪）`); } })
        .on('p', { element(el) { el.after('<p><a href="/api/vars">看 vars</a></p>', { html: true }); } })
        .transform(page);
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch, env) {
    const done = Number((await env.KV.get('jobs-done')) || 0);
    await env.KV.put('jobs-done', String(done + batch.messages.length));
    for (const m of batch.messages) m.ack();
  },

  async scheduled(event, env) {
    await env.KV.put('last-cron', `${event.cron} @ ${new Date(event.scheduledTime).toISOString()}`);
  },
};
