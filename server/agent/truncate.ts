/** D-26：ツール出力の上限（トークン） */
export const OUTPUT_TOKEN_LIMIT = 8000;

export type CountTokens = (text: string) => Promise<number>;

const marker = (lines: number) => `…${lines} 行省略。startLine / endLine を指定して読めます…`;

/**
 * 上限を超えたら先頭と末尾を残して間を省く（FR-009）。
 * トークンは 1 つが 1 バイト以上なので、バイト数が上限以下なら数えるまでもなく収まる
 */
export async function truncateOutput(text: string, countTokens: CountTokens, limit = OUTPUT_TOKEN_LIMIT): Promise<string> {
  if (Buffer.byteLength(text) <= limit) return text;
  const total = await countTokens(text);
  if (total <= limit) return text;

  // 文字数に比例して見積もり、収まるまで縮める
  let keep = Math.floor((text.length * limit) / total / 2);
  for (;;) {
    const result = cut(text, keep);
    if (keep === 0 || (await countTokens(result)) <= limit) return result;
    keep = Math.floor(keep * 0.8);
  }
}

/** 先頭と末尾を keep 文字ずつ残す。行の途中で切れる場合は直前の改行まで戻す */
function cut(text: string, keep: number): string {
  let headEnd = keep;
  const headBreak = text.lastIndexOf("\n", headEnd);
  if (headBreak > 0) headEnd = headBreak + 1;
  let tailStart = text.length - keep;
  const tailBreak = text.indexOf("\n", tailStart);
  if (tailBreak >= 0 && tailBreak < text.length - 1) tailStart = tailBreak + 1;
  if (tailStart <= headEnd) return text;
  const omitted = text.slice(headEnd, tailStart);
  const lines = (omitted.match(/\n/g)?.length ?? 0) + (omitted.endsWith("\n") ? 0 : 1);
  return `${text.slice(0, headEnd)}${headEnd > 0 && !text.slice(0, headEnd).endsWith("\n") ? "\n" : ""}${marker(lines)}\n${text.slice(tailStart)}`;
}
