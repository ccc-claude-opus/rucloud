let count = 0;

export default {
  async fetch(req) {
    const url = new URL(req.url);
    count++;
    switch (url.pathname) {
      case '/w/cached':
        return new Response(`count ${count}`, { headers: { 'cache-control': 'public, max-age=60' } });
      case '/w/private':
        return new Response(`count ${count}`, { headers: { 'cache-control': 'private, max-age=60' } });
      case '/w/big':
        return new Response('x'.repeat(300_000), { headers: { 'cache-control': 'max-age=60' } });
      case '/w/api-cache': {
        const cache = caches.default;
        const hit = await cache.match(req);
        if (hit) return new Response(`from cache: ${await hit.text()}`);
        const fresh = new Response(`made by pid ${process.pid}`, { headers: { 'cache-control': 'max-age=60' } });
        await cache.put(req, fresh.clone());
        return fresh;
      }
      case '/w/sse':
        return new Response('data: ' + 'x'.repeat(2000) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
      case '/w/url':
        return new Response(req.url);
      default:
        return new Response('not found', { status: 404 });
    }
  },
};
