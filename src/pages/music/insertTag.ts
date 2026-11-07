/**
 * カーソルの位置に [tag] を1行で入れる。行の途中なら前で改行し、入れたあとのカーソルはタグの次の行の頭。
 * 続きが同じ行に残るときは、タグの次の行へ送る
 */
export function insertTag(text: string, cursor: number, tag: string): { text: string; cursor: number } {
  const at = Math.min(Math.max(cursor, 0), text.length);
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const line = `${lead}[${tag}]`;
  // 続きがすでに改行から始まる（行末・末尾の改行）なら、その改行をタグの終わりに使う
  const tail = after.startsWith("\n") ? "" : "\n";
  const inserted = before + line + tail;
  return { text: inserted + after, cursor: inserted.length + (tail === "" ? 1 : 0) };
}
