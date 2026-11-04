import { connect } from 'cloudflare:sockets';

async function readAll(readable) {
  let out = '';
  const dec = new TextDecoder();
  for await (const chunk of readable) out += dec.decode(chunk, { stream: true });
  return out;
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const port = Number(url.searchParams.get('port'));
    if (url.pathname === '/echo') {
      const socket = connect({ hostname: '127.0.0.1', port });
      const { remoteAddress } = await socket.opened;
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode('hello rucloud'));
      await writer.close();
      const text = await readAll(socket.readable);
      await socket.close();
      return Response.json({ text, remote: remoteAddress.endsWith(`:${port}`) });
    }
    if (url.pathname === '/http') {
      const socket = connect(`127.0.0.1:${port}`);
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode('GET / HTTP/1.0\r\nHost: x\r\n\r\n'));
      const text = await readAll(socket.readable);
      return new Response(text.split('\r\n\r\n')[1]);
    }
    if (url.pathname === '/refused') {
      try {
        await connect({ hostname: '127.0.0.1', port }).opened;
        return new Response('connected?');
      } catch (e) {
        return new Response(`error: ${e.code}`);
      }
    }
    return new Response('ok');
  },
};
