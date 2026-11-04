export enum Op { Add = 'add', Mul = 'mul' }
export function apply(op: Op, a: number, b: number): number {
  return op === Op.Add ? a + b : a * b;
}
