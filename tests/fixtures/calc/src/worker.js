import { WorkerEntrypoint } from 'cloudflare:workers';

export default class Calc extends WorkerEntrypoint {
  async fetch(req) {
    if (new URL(req.url).pathname === '/echo') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener('message', (e) => server.send(`calc got ${e.data}`));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('calc');
  }
  add(a, b) { return a + b; }
  echo(v) { return v; }
  whoami() { return this.env.NAME; }
}

export class Admin extends WorkerEntrypoint {
  secret() { return 'admin-only'; }
}
