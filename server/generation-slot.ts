/** llama-server は同時に1つしか生成しない（D-60）。会話のターンと評価のケースがここで順番を待つ */
export class GenerationSlot {
  /** 評価の実行中はそのプリセット。別のプリセットの送信を断るのに使う（FR-016） */
  evalPresetId: string | null = null;
  private busy = false;
  private waiting: { resolve(release: () => void): void }[] = [];

  /** 順番が来たら release を返す。待っている間に signal が止まったら reject する */
  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const entry = {
        resolve: (release: () => void) => {
          signal.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(entry);
      this.next();
    });
  }

  private next(): void {
    if (this.busy) return;
    const entry = this.waiting.shift();
    if (!entry) return;
    this.busy = true;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      this.busy = false;
      this.next();
    });
  }
}
