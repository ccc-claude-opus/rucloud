import { Op, apply } from './lib/math';
import hello from '../assets/hello.txt';
import readme from '../assets/readme.md';
import data from '../assets/data.bin';
import wasm from '../assets/add.wasm';
import wasm2 from '../assets/add.wasm?module';
import config from '../assets/config.json';

interface Env { STAGE: string; DB: D1Database }
type D1Database = any;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const inst = new WebAssembly.Instance(wasm);
    const add = inst.exports.add as (a: number, b: number) => number;
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Response.json({
      stage: env.STAGE,
      enum: apply(Op.Mul, 6, 7),
      text: hello.trim(),
      md: readme.trim(),
      bin: [...new Uint8Array(data)],
      wasm: add(2, 3),
      sameModule: wasm2 instanceof WebAssembly.Module,
      json: config.version,
      tables: tables.results.map((r: { name: string }) => r.name),
    });
  },
};
