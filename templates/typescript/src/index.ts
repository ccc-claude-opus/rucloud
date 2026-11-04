// Env 的型別由 `rucloud types` 產生在 worker-configuration.d.ts
import { counter } from './lib';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const n = await counter(env.KV, new URL(request.url).pathname);
    return Response.json({ path: new URL(request.url).pathname, visits: n });
  },
} satisfies ExportedHandler<Env>;
