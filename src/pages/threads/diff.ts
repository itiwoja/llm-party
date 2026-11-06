/** 前後の中身から unified の文字列を作る（FR-011）。サーバーの server/agent/diff.ts とは別に、画面側で持つ */

const CONTEXT = 3;
/** LCS の表の大きさの上限。超えたら全行を消して全行を足す形にする */
const MAX_CELLS = 4_000_000;

type Op = { t: " " | "+" | "-"; line: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function ops(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map((line): Op => ({ t: " ", line }));
  const tail = a.slice(endA).map((line): Op => ({ t: " ", line }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const middle: Op[] = [];
  if (x.length * y.length > MAX_CELLS) {
    x.forEach((line) => middle.push({ t: "-", line }));
    y.forEach((line) => middle.push({ t: "+", line }));
  } else {
    const w = y.length + 1;
    const table = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { middle.push({ t: " ", line: x[i] }); i++; j++; }
      else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) middle.push({ t: "-", line: x[i++] });
      else middle.push({ t: "+", line: y[j++] });
    }
    while (i < x.length) middle.push({ t: "-", line: x[i++] });
    while (j < y.length) middle.push({ t: "+", line: y[j++] });
  }
  return [...head, ...middle, ...tail];
}

/** before が null なら新規作成、after が null なら削除。差がなければ空文字 */
export function unifiedDiff(file: string, before: string | null, after: string | null): string {
  const all = ops(splitLines(before ?? ""), splitLines(after ?? ""));
  if (!all.some((o) => o.t !== " ")) return "";
  const out = [before === null ? "--- /dev/null" : `--- a/${file}`, after === null ? "+++ /dev/null" : `+++ b/${file}`];
  const keep = all.map((o, i) => o.t !== " " || all.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((n) => n.t !== " "));
  let i = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < all.length) {
    if (!keep[i]) {
      if (all[i].t !== "+") oldNo++;
      if (all[i].t !== "-") newNo++;
      i++;
      continue;
    }
    let end = i;
    while (end < all.length && keep[end]) end++;
    const chunk = all.slice(i, end);
    const oldCount = chunk.filter((o) => o.t !== "+").length;
    const newCount = chunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${oldCount ? oldNo : oldNo - 1},${oldCount} +${newCount ? newNo : newNo - 1},${newCount} @@`);
    for (const o of chunk) out.push(o.t + o.line);
    oldNo += oldCount;
    newNo += newCount;
    i = end;
  }
  return out.join("\n");
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";
export interface DiffLine { kind: DiffLineKind; text: string }

/** unified の文字列を行ごとに分類する。HTML には流さず、呼ぶ側が文字として描く */
export function classifyDiff(diff: string): DiffLine[] {
  return diff.split("\n").map((raw): DiffLine => {
    if (raw.startsWith("+++") || raw.startsWith("---")) return { kind: "meta", text: raw };
    if (raw.startsWith("@@")) return { kind: "hunk", text: raw };
    if (raw.startsWith("+")) return { kind: "add", text: raw.slice(1) };
    if (raw.startsWith("-")) return { kind: "del", text: raw.slice(1) };
    return { kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw };
  });
}

export function countChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of classifyDiff(diff)) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}
