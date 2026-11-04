import { DurableObject } from 'cloudflare:workers';

let created = 0;

export class Obj extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    created++;
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hits (n INTEGER)');
  }
  hit() {
    this.ctx.storage.sql.exec('INSERT INTO hits VALUES (1)');
    return { created, hits: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM hits').one().n };
  }
}

export default {
  async fetch(req, env) {
    return Response.json(await env.OBJ.getByName('one').hit());
  },
};
