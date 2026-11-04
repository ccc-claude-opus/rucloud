// rucloud 對 `import ... from 'cloudflare:workers'` 的實作（由 host.mjs 的模組 hook 導到這裡）

const rt = globalThis.__rucloud || {};

export const env = rt.env || {};

export function waitUntil(promise) {
  rt.waitUntil?.(promise);
}

export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}
