import fs from 'node:fs';
import cp from 'node:child_process';

const attempt = async (f) => {
  try { return { ok: true, value: await f() }; } catch (e) { return { ok: false, code: e.code || e.message }; }
};

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (p === '/loop') for (;;) { /* 卡住事件迴圈 */ }
    if (p === '/pid') return new Response(String(process.pid));
    return Response.json({
      readOutside: await attempt(() => fs.readFileSync('/etc/hosts', 'utf8')),
      readOwn: await attempt(() => fs.readFileSync('wrangler.jsonc', 'utf8').length),
      write: await attempt(() => fs.writeFileSync('owned.txt', 'x')),
      child: await attempt(() => cp.execSync('echo hi').toString()),
      env: Object.keys(process.env),
      kv: await attempt(async () => { await env.KV.put('a', '1'); return env.KV.get('a'); }),
    });
  },
};
