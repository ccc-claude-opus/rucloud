// /ws?room=名稱&name=暱稱  加入聊天室（SQLite 型 Durable Object + WebSocket hibernation）
// /echo                    最簡單的 WebSocket：Worker 自己回聲
import { DurableObject } from 'cloudflare:workers';

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 每個房間有自己的 SQLite 資料庫，存聊天紀錄
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')))`);
  }

  async fetch(request) {
    const name = new URL(request.url).searchParams.get('name') || '匿名';
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [name]);
    server.serializeAttachment({ name });
    // 新加入的人先收到最近 20 則紀錄
    const recent = this.ctx.storage.sql.exec('SELECT id, name, text FROM messages ORDER BY id DESC LIMIT 20').toArray().reverse();
    server.send(JSON.stringify({ type: 'history', messages: recent }));
    this.broadcast({ type: 'join', name, online: this.ctx.getWebSockets().length });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const { name } = ws.deserializeAttachment();
    const { id } = this.ctx.storage.sql
      .exec('INSERT INTO messages (name, text) VALUES (?, ?) RETURNING id', name, String(message).slice(0, 2000))
      .one();
    this.broadcast({ type: 'message', name, text: String(message), n: id });
  }

  async webSocketClose(ws, code) {
    const { name } = ws.deserializeAttachment();
    this.broadcast({ type: 'leave', name, online: this.ctx.getWebSockets().length });
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) ws.send(text);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');
    if (url.pathname === '/ws') {
      if (upgrade !== 'websocket') return new Response('需要 WebSocket', { status: 426 });
      return env.ROOMS.getByName(url.searchParams.get('room') || 'lobby').fetch(request);
    }
    if (url.pathname === '/echo') {
      if (upgrade !== 'websocket') return new Response('需要 WebSocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener('message', (e) => server.send(`echo: ${e.data}`));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  },
};
