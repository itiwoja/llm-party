/**
 * llama-server の --parallel と同じ数。同時に生成できる本数（D-60 の改訂）。
 * 文脈長 -c は llama-server が本数で割って使うので、1本あたりの文脈は半分になる（chat.ts で割って扱う）
 */
export const GENERATION_SLOTS = 2;

/**
 * 生成の枠。会話のターン・評価のケース・画像生成が順番を待つ。
 * 枠は「読み込みの key（engine の loadKey）が同じ」ものどうしでだけ一緒に持てる。
 * 違う読み込みは、持っている枠がすべて空くまで待つ（違うモデルを読み直すと、動いている生成が止まるため）
 */
export class GenerationSlot {
  /** 評価の実行中はそのプリセット。別のプリセットの送信を断るのに使う（FR-016） */
  evalPresetId: string | null = null;
  private holders = 0;
  private key: string | null = null;
  private waiting: { key: string; resolve(release: () => void): void }[] = [];

  /** 順番が来たら release を返す。待っている間に signal が止まったら reject する */
  acquire(signal: AbortSignal, key: string): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const entry = {
        key,
        resolve: (release: () => void) => {
          signal.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        reject(signal.reason);
        this.next();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(entry);
      this.next();
    });
  }

  /** 先頭から順に渡す。先頭が違う key なら、持っている枠が空くまで止める（来た順を守る） */
  private next(): void {
    while (this.holders < GENERATION_SLOTS) {
      const head = this.waiting[0];
      if (!head) return;
      if (this.holders > 0 && head.key !== this.key) return;
      this.waiting.shift();
      if (this.holders === 0) this.key = head.key;
      this.holders += 1;
      let released = false;
      head.resolve(() => {
        if (released) return;
        released = true;
        this.holders -= 1;
        this.next();
      });
    }
  }
}
