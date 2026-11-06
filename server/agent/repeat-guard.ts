/** D-70：思考のループの検知。短い行（Okay. など）は普通の思考でも繰り返すので数えない */
export const REPEAT_MIN_LENGTH = 20;
export const REPEAT_LIMIT = 5;

/** 差分で届く文章を行ごとに数え、同じ行が REPEAT_LIMIT 回に達したら true を返す */
export class RepeatGuard {
  private counts = new Map<string, number>();
  private partial = "";

  feed(delta: string): boolean {
    const lines = (this.partial + delta).split("\n");
    this.partial = lines.pop() ?? "";
    let repeated = false;
    for (const raw of lines) {
      const line = raw.trim().replace(/\s+/g, " ");
      if (line.length < REPEAT_MIN_LENGTH) continue;
      const count = (this.counts.get(line) ?? 0) + 1;
      this.counts.set(line, count);
      if (count >= REPEAT_LIMIT) repeated = true;
    }
    return repeated;
  }
}
