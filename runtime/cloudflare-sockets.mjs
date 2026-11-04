// rucloud 對 `import { connect } from 'cloudflare:sockets'` 的實作：用 Node 的 net / tls 開 TCP 連線
//
//   const socket = connect({ hostname: 'db.example.com', port: 5432 }, { secureTransport: 'off' | 'on' | 'starttls' });
//   const writer = socket.writable.getWriter(); await writer.write(bytes);
//   const reader = socket.readable.getReader(); ...
//   await socket.close();

import net from 'node:net';
import tls from 'node:tls';
import { Readable, Writable } from 'node:stream';

function parseAddress(address) {
  if (typeof address !== 'string') return { hostname: address.hostname, port: Number(address.port) };
  const i = address.lastIndexOf(':');
  if (i < 0) throw new TypeError('位址要寫成 "host:port"');
  return { hostname: address.slice(0, i).replace(/^\[|\]$/g, ''), port: Number(address.slice(i + 1)) };
}

class Socket {
  constructor(raw, { hostname, secureTransport, secure }) {
    this._raw = raw;
    this._hostname = hostname;
    this._secureTransport = secureTransport;
    this.opened = new Promise((resolve, reject) => {
      const done = () => resolve({ remoteAddress: `${raw.remoteAddress}:${raw.remotePort}`, localAddress: `${raw.localAddress}:${raw.localPort}` });
      // 已經是建立好的連線（startTls 之前就連上了）
      if (!secure && !raw.connecting) return done();
      raw.once(secure ? 'secureConnect' : 'connect', done);
      raw.once('error', reject);
    });
    this.closed = new Promise((resolve, reject) => {
      raw.once('close', () => resolve());
      raw.once('error', reject);
    });
    // 沒人等這兩個 promise 時，錯誤不要變成 unhandled rejection
    this.opened.catch(() => {});
    this.closed.catch(() => {});
    this.readable = Readable.toWeb(raw);
    this.writable = Writable.toWeb(raw);
  }

  async close() {
    this._raw.end();
    this._raw.destroySoon?.();
    setTimeout(() => this._raw.destroy(), 1000).unref();
    return this.closed;
  }

  startTls(options = {}) {
    if (this._secureTransport !== 'starttls') throw new Error("startTls() 需要在 connect() 時指定 secureTransport: 'starttls'");
    const t = tls.connect({ socket: this._raw, servername: options.expectedServerHostname ?? this._hostname });
    return new Socket(t, { hostname: this._hostname, secureTransport: 'on', secure: true });
  }
}

export function connect(address, options = {}) {
  const { hostname, port } = parseAddress(address);
  if (!hostname || !(port > 0 && port < 65536)) throw new TypeError('connect() 需要 hostname 與 port');
  const secureTransport = options.secureTransport ?? 'off';
  const raw = secureTransport === 'on'
    ? tls.connect({ host: hostname, port, servername: hostname, allowHalfOpen: !!options.allowHalfOpen })
    : net.connect({ host: hostname, port, allowHalfOpen: !!options.allowHalfOpen });
  raw.setNoDelay(true);
  return new Socket(raw, { hostname, secureTransport, secure: secureTransport === 'on' });
}

export default { connect };
