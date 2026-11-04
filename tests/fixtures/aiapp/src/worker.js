const messages = [{ role: 'user', content: 'hi' }];

export default {
  async fetch(req, env) {
    switch (new URL(req.url).pathname) {
      case '/chat': return Response.json(await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages }));
      case '/stream': {
        const stream = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages, stream: true });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      case '/embed': return Response.json(await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: ['a', 'b'] }));
      default: return new Response('ok');
    }
  },
};
