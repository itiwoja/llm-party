const CONTEXT = 3;

type Op = { kind: " " | "-" | "+"; line: string };

const toLines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** 共通の先頭・末尾を除いた中央を LCS で比べる。プレビュー用なので巨大な差分は丸ごと置き換えとして扱う */
function diffOps(before: string[], after: string[]): Op[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before.at(-1 - tail) === after.at(-1 - tail)) tail += 1;
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);

  const ops: Op[] = before.slice(0, head).map((line) => ({ kind: " ", line }));
  if (a.length * b.length > 4_000_000) {
    ops.push(...a.map((line): Op => ({ kind: "-", line })), ...b.map((line): Op => ({ kind: "+", line })));
  } else {
    const lcs = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        ops.push({ kind: " ", line: a[i] });
        i += 1;
        j += 1;
      } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
        ops.push({ kind: "-", line: a[i] });
        i += 1;
      } else {
        ops.push({ kind: "+", line: b[j] });
        j += 1;
      }
    }
  }
  ops.push(...before.slice(before.length - tail).map((line): Op => ({ kind: " ", line })));
  return ops;
}

/** unified diff。`before` が null なら新規作成。差がなければ空文字 */
export function unifiedDiff(file: string, before: string | null, after: string): string {
  const ops = diffOps(toLines(before ?? ""), toLines(after));
  if (!ops.some((op) => op.kind !== " ")) return "";

  // 変更の前後 CONTEXT 行を残して、離れた変更は別のハンクにする
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k += 1) keep[k] = true;
  });

  const out = [before === null ? "--- /dev/null" : `--- a/${file}`, `+++ b/${file}`];
  let oldLine = 1;
  let newLine = 1;
  let index = 0;
  while (index < ops.length) {
    if (!keep[index]) {
      if (ops[index].kind !== "+") oldLine += 1;
      if (ops[index].kind !== "-") newLine += 1;
      index += 1;
      continue;
    }
    const hunkOld = oldLine;
    const hunkNew = newLine;
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    while (index < ops.length && keep[index]) {
      const { kind, line } = ops[index];
      body.push(kind + line);
      if (kind !== "+") oldCount += 1;
      if (kind !== "-") newCount += 1;
      index += 1;
    }
    oldLine += oldCount;
    newLine += newCount;
    out.push(`@@ -${oldCount === 0 ? hunkOld - 1 : hunkOld},${oldCount} +${newCount === 0 ? hunkNew - 1 : hunkNew},${newCount} @@`, ...body);
  }
  return out.join("\n");
}
