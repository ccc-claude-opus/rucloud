export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const key = url.searchParams.get('key');
    switch (url.pathname) {
      case '/hd': {
        const { connectionString, host, port, user, password, database } = env.HD;
        return Response.json({ connectionString, host, port, user, password, database });
      }
      case '/ae':
        for (const [path, ms] of [['/a', 10], ['/a', 30], ['/b', 5]]) env.AE.writeDataPoint({ blobs: [path], doubles: [ms], indexes: ['u1'] });
        return new Response('ok');
      case '/r2put': await env.FILES.put(key, 'x'); return new Response('ok');
      case '/r2del': await env.FILES.delete(key); return new Response('ok');
      case '/events': return Response.json((await env.KV.get('events', 'json')) || []);
      case '/out': await env.OUT.send({ hello: 'pull' }, { contentType: 'json' }); return new Response('ok');
      default: return new Response('ok');
    }
  },
  async queue(batch, env) {
    const events = (await env.KV.get('events', 'json')) || [];
    for (const m of batch.messages) events.push({ action: m.body.action, key: m.body.object.key, bucket: m.body.bucket });
    await env.KV.put('events', JSON.stringify(events));
  },
};
