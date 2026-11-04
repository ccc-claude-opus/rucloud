export async function counter(kv: KVNamespace, key: string): Promise<number> {
  const n = Number((await kv.get(key)) ?? 0) + 1;
  await kv.put(key, String(n));
  return n;
}
