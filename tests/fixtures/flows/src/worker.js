import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

// 模組層級的計數：用來確認重播時已完成的步驟不會再跑一次
const ran = { charge: 0, flaky: 0, runs: 0 };

export class OrderFlow extends WorkflowEntrypoint {
  async run(event, step) {
    ran.runs++;
    const charged = await step.do('charge', async () => { ran.charge++; return { amount: event.payload.amount, at: new Date(0) }; });
    const flaky = await step.do('flaky', { retries: { limit: 3, delay: 10, backoff: 'constant' } }, async () => {
      ran.flaky++;
      if (ran.flaky < 3) throw new Error('暫時失敗');
      return ran.flaky;
    });
    await step.sleep('nap', '1 second');
    const ev = await step.waitForEvent('approval', { type: 'approve', timeout: '1 minute' });
    const shipped = await step.do('ship', async () => `shipped by ${ev.payload.by}`);
    return { amount: charged.amount, isDate: charged.at instanceof Date, flaky, shipped, ran: { ...ran } };
  }
}

export class FailFlow extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do('nope', async () => { throw new NonRetryableError('不能重試的錯誤'); });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    switch (url.pathname) {
      case '/wf/create': return Response.json({ id: (await env.ORDERS.create({ id, params: { amount: 100 } })).id });
      case '/wf/status': return Response.json(await (await env.ORDERS.get(id)).status());
      case '/wf/approve': await (await env.ORDERS.get(id)).sendEvent({ type: 'approve', payload: { by: 'amy' } }); return new Response('ok');
      case '/wf/pause': await (await env.ORDERS.get(id)).pause(); return new Response('ok');
      case '/wf/resume': await (await env.ORDERS.get(id)).resume(); return new Response('ok');
      case '/wf/terminate': await (await env.ORDERS.get(id)).terminate(); return new Response('ok');
      case '/wf/fail': return Response.json({ id: (await env.FAILS.create()).id });
      case '/wf/fail-status': return Response.json(await (await env.FAILS.get(id)).status());
      case '/rpc': {
        let err;
        try { await env.CALC.nope(); } catch (e) { err = e.message; }
        return Response.json({
          sum: await env.CALC.add(2, 3),
          date: (await env.CALC.echo(new Date(0))) instanceof Date,
          map: (await env.CALC.echo(new Map([['a', 1]]))).get('a'),
          name: await env.CALC.whoami(),
          admin: await env.CALC_ADMIN.secret(),
          fetched: await (await env.CALC.fetch('https://calc/')).text(),
          err,
        });
      }
      case '/ws-out': {
        const r = await fetch(url.searchParams.get('target'), { headers: { Upgrade: 'websocket' } });
        const ws = r.webSocket;
        ws.accept();
        return new Promise((resolve) => {
          ws.addEventListener('message', (e) => { resolve(new Response(String(e.data))); ws.close(); });
          ws.send('ping');
        });
      }
      default: return new Response('ok');
    }
  },
};
