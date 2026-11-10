// /ws  即時對戰頻道：房間、走子同步、聊天室、ELO 積分排行
// 原本 boardgame-arena 是 Express + ws 的 in-memory 伺服器，移植成
// 單一 Durable Object（全站共用一個 Arena 實例，getByName('arena')），
// 狀態（房間 / 聊天 / 玩家）存 SQLite storage，WebSocket 用 hibernation API。
import { DurableObject } from 'cloudflare:workers';

const AI_NAME = 'AI 機器人';
const SEED_PLAYERS = [
  { name: '無雙國士', elo: 1680, wins: 42, losses: 11, draws: 4, favoriteGame: 'xiangqi' },
  { name: '黑白棋聖', elo: 1595, wins: 38, losses: 14, draws: 2, favoriteGame: 'gomoku' },
  { name: 'GrandMaster_K', elo: 1540, wins: 31, losses: 15, draws: 6, favoriteGame: 'chess' },
  { name: '跳棋飛將', elo: 1465, wins: 25, losses: 13, draws: 1, favoriteGame: 'checkers' },
  { name: '地產大亨', elo: 1410, wins: 19, losses: 12, draws: 0, favoriteGame: 'monopoly' },
  { name: '清風徐來', elo: 1320, wins: 14, losses: 11, draws: 3, favoriteGame: 'xiangqi' },
];

export class Arena extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS players (
      name TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, sender TEXT NOT NULL,
      text TEXT NOT NULL, at INTEGER NOT NULL, is_system INTEGER NOT NULL DEFAULT 0)`);
    if (!sql.exec('SELECT 1 FROM players LIMIT 1').toArray().length) {
      for (const p of SEED_PLAYERS) {
        sql.exec('INSERT INTO players (name, data) VALUES (?, ?)', p.name, JSON.stringify(p));
      }
    }
  }

  // ---- 資料讀寫 ----

  getRooms() {
    return this.ctx.storage.sql
      .exec('SELECT data FROM rooms ORDER BY created_at DESC')
      .toArray()
      .map((r) => JSON.parse(r.data));
  }

  getRoom(id) {
    const row = this.ctx.storage.sql
      .exec('SELECT data FROM rooms WHERE id = ?', id)
      .toArray()[0];
    return row ? JSON.parse(row.data) : null;
  }

  saveRoom(room) {
    this.ctx.storage.sql.exec(
      'INSERT INTO rooms (id, data, created_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      room.id,
      JSON.stringify(room),
      room.createdAt
    );
  }

  getLeaderboard() {
    return this.ctx.storage.sql
      .exec('SELECT data FROM players')
      .toArray()
      .map((r) => JSON.parse(r.data))
      .sort((a, b) => b.elo - a.elo);
  }

  getChat(roomId) {
    return this.ctx.storage.sql
      .exec(
        'SELECT id, room_id, sender, text, at, is_system FROM ' +
          '(SELECT id, room_id, sender, text, at, is_system FROM messages WHERE room_id = ? ORDER BY at DESC LIMIT 60) ' +
          'ORDER BY at ASC',
        roomId
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        roomId: r.room_id,
        sender: r.sender,
        text: r.text,
        timestamp: r.at,
        isSystem: !!r.is_system,
      }));
  }

  ensurePlayer(name, favoriteGame) {
    const row = this.ctx.storage.sql
      .exec('SELECT data FROM players WHERE name = ?', name)
      .toArray()[0];
    if (row) return JSON.parse(row.data);
    const entry = { name, elo: 1200, wins: 0, losses: 0, draws: 0, favoriteGame };
    this.ctx.storage.sql.exec(
      'INSERT INTO players (name, data) VALUES (?, ?)',
      name,
      JSON.stringify(entry)
    );
    return entry;
  }

  // ELO 結算（和原版相同的 K=32 公式）
  updateElo(winnerName, loserName, gameType, isDraw) {
    const isWinnerAI = winnerName === AI_NAME;
    const isLoserAI = loserName === AI_NAME;
    if (!isWinnerAI) this.ensurePlayer(winnerName, gameType);
    if (!isLoserAI) this.ensurePlayer(loserName, gameType);

    const dummy = { elo: 1250, wins: 0, losses: 0, draws: 0, name: 'AI', favoriteGame: gameType };
    const w = isWinnerAI ? { ...dummy } : this.ensurePlayer(winnerName, gameType);
    const l = isLoserAI ? { ...dummy } : this.ensurePlayer(loserName, gameType);

    const K = 32;
    const expectedW = 1 / (1 + Math.pow(10, (l.elo - w.elo) / 400));
    const expectedL = 1 - expectedW;
    const save = (p) =>
      this.ctx.storage.sql.exec(
        'UPDATE players SET data = ? WHERE name = ?',
        JSON.stringify(p),
        p.name
      );

    if (isDraw) {
      if (!isWinnerAI) {
        w.elo = Math.round(w.elo + K * (0.5 - expectedW));
        w.draws += 1;
        save(w);
      }
      if (!isLoserAI) {
        l.elo = Math.round(l.elo + K * (0.5 - expectedL));
        l.draws += 1;
        save(l);
      }
    } else {
      if (!isWinnerAI) {
        w.elo = Math.round(w.elo + K * (1 - expectedW));
        w.wins += 1;
        w.favoriteGame = gameType;
        save(w);
      }
      if (!isLoserAI) {
        l.elo = Math.max(800, Math.round(l.elo + K * (0 - expectedL)));
        l.losses += 1;
        save(l);
      }
    }
  }

  // ---- 廣播 ----

  clients() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, meta: ws.deserializeAttachment() }));
  }

  broadcastAll(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const { ws } of this.clients()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  broadcastRoom(roomId, type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const { ws, meta } of this.clients()) {
      if (meta?.roomId === roomId) {
        try {
          ws.send(msg);
        } catch {}
      }
    }
  }

  systemMessage(roomId, sender, text) {
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      roomId,
      sender,
      text,
      timestamp: Date.now(),
      isSystem: true,
    };
    this.ctx.storage.sql.exec(
      'INSERT INTO messages (id, room_id, sender, text, at, is_system) VALUES (?, ?, ?, ?, ?, 1)',
      msg.id,
      roomId,
      msg.sender,
      msg.text,
      msg.timestamp
    );
    return msg;
  }

  // ---- WebSocket 生命週期 ----

  async fetch(request) {
    const url = new URL(request.url);
    const name = url.searchParams.get('name') || '訪客';
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [name]);
    server.serializeAttachment({ roomId: null, playerName: name });

    server.send(
      JSON.stringify({
        type: 'init',
        payload: {
          rooms: this.getRooms(),
          leaderboard: this.getLeaderboard(),
          globalChat: this.getChat('global'),
        },
      })
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(String(message));
    } catch {
      return;
    }
    const { type, payload } = data;
    const meta = ws.deserializeAttachment();

    if (type === 'player:identify') {
      meta.playerName = payload?.name || '訪客';
      ws.serializeAttachment(meta);
    }

    if (type === 'room:create') {
      const { gameType, mode, hostName } = payload;
      const id = Math.random().toString(36).slice(2, 8).toUpperCase();
      const room = {
        id,
        gameType,
        mode,
        status: mode === 'ai' ? 'playing' : 'waiting',
        hostName: hostName || '玩家一',
        guestName: mode === 'ai' ? AI_NAME : undefined,
        spectatorCount: 0,
        moveCount: 0,
        currentTurn: 'p1',
        winner: null,
        createdAt: Date.now(),
      };
      this.saveRoom(room);
      this.systemMessage(id, '系統', `${room.hostName} 建立了房間 #${id}`);
      meta.roomId = id;
      meta.playerName = room.hostName;
      ws.serializeAttachment(meta);
      ws.send(JSON.stringify({ type: 'room:joined', payload: { room, role: 'p1', chat: this.getChat(id) } }));
      this.broadcastAll('rooms:update', this.getRooms());
    }

    if (type === 'room:join') {
      const { roomId, guestName } = payload;
      const room = this.getRoom(roomId);
      if (!room) return;
      let role;
      if (room.status === 'waiting' && !room.guestName) {
        room.guestName = guestName || '玩家二';
        room.status = 'playing';
        this.saveRoom(room);
        role = 'p2';
        meta.playerName = room.guestName;
      } else {
        room.spectatorCount += 1;
        this.saveRoom(room);
        role = 'spectator';
      }
      meta.roomId = roomId;
      ws.serializeAttachment(meta);
      ws.send(JSON.stringify({ type: 'room:joined', payload: { room, role, chat: this.getChat(roomId) } }));
      this.broadcastRoom(roomId, 'room:state', room);
      this.broadcastAll('rooms:update', this.getRooms());
    }

    if (type === 'room:spectate') {
      const { roomId } = payload;
      const room = this.getRoom(roomId);
      if (!room) return;
      room.spectatorCount += 1;
      this.saveRoom(room);
      meta.roomId = roomId;
      ws.serializeAttachment(meta);
      ws.send(JSON.stringify({ type: 'room:joined', payload: { room, role: 'spectator', chat: this.getChat(roomId) } }));
      this.broadcastRoom(roomId, 'room:state', room);
      this.broadcastAll('rooms:update', this.getRooms());
    }

    if (type === 'room:leave') {
      const { roomId, role } = payload || {};
      const room = this.getRoom(roomId);
      if (room && role === 'spectator' && room.spectatorCount > 0) {
        room.spectatorCount -= 1;
        this.saveRoom(room);
      }
      meta.roomId = null;
      ws.serializeAttachment(meta);
      this.broadcastAll('rooms:update', this.getRooms());
    }

    if (type === 'room:move') {
      const { roomId, boardState, nextTurn, moveCount, winner } = payload;
      const room = this.getRoom(roomId);
      if (!room) return;
      room.boardState = boardState;
      room.currentTurn = nextTurn;
      room.moveCount = moveCount;
      if (winner && room.status !== 'finished') {
        room.winner = winner;
        room.status = 'finished';
        const p1 = room.hostName;
        const p2 = room.guestName || AI_NAME;
        if (winner === 'p1') this.updateElo(p1, p2, room.gameType, false);
        else if (winner === 'p2') this.updateElo(p2, p1, room.gameType, false);
        else if (winner === 'draw') this.updateElo(p1, p2, room.gameType, true);
        this.broadcastAll('leaderboard:update', this.getLeaderboard());
      }
      this.saveRoom(room);
      this.broadcastRoom(roomId, 'room:state', room);
      this.broadcastAll('rooms:update', this.getRooms());
    }

    if (type === 'room:reset') {
      const { roomId, boardState } = payload || {};
      const room = this.getRoom(roomId);
      if (!room) return;
      room.boardState = boardState;
      room.currentTurn = 'p1';
      room.moveCount = 0;
      room.winner = null;
      room.status = room.mode === 'ai' || room.guestName ? 'playing' : 'waiting';
      this.saveRoom(room);
      this.broadcastRoom(roomId, 'room:state', room);
      this.broadcastAll('rooms:update', this.getRooms());
    }

    if (type === 'chat:send') {
      const { roomId, sender, text } = payload;
      if (!text || !text.trim()) return;
      const msg = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        roomId: roomId || 'global',
        sender: sender || '訪客',
        text: text.trim().slice(0, 200),
        timestamp: Date.now(),
      };
      this.ctx.storage.sql.exec(
        'INSERT INTO messages (id, room_id, sender, text, at, is_system) VALUES (?, ?, ?, ?, ?, 0)',
        msg.id,
        msg.roomId,
        msg.sender,
        msg.text,
        msg.timestamp
      );
      if (msg.roomId === 'global') this.broadcastAll('chat:message', msg);
      else this.broadcastRoom(msg.roomId, 'chat:message', msg);
    }
  }

  async webSocketClose(ws) {
    const meta = ws.deserializeAttachment();
    if (meta?.roomId) {
      const room = this.getRoom(meta.roomId);
      if (room && room.spectatorCount > 0) {
        room.spectatorCount -= 1;
        this.saveRoom(room);
        this.broadcastAll('rooms:update', this.getRooms());
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket')
        return new Response('需要 WebSocket', { status: 426 });
      // 全站狀態共用一個 Arena 實例
      return env.ARENA.getByName('arena').fetch(request);
    }
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' });
    }
    return new Response('not found', { status: 404 });
  },
};
