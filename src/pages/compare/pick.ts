/** 評価セットや PG-006 から比較を開くときの、ラン B の指定。ハッシュのルートに載せられないのでここで受け渡す */
let pending: { setId: string; runId: string } | null = null;

export function setPendingCompare(setId: string, runId: string): void {
  pending = { setId, runId };
}

export function takePendingCompare(setId: string): string | null {
  const value = pending && pending.setId === setId ? pending.runId : null;
  pending = null;
  return value;
}
