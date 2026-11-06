import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/pages/threads/ansi";
import { classifyDiff, countChanges, unifiedDiff } from "../src/pages/threads/diff";

describe("PG-001 の差分と端末の部品", () => {
  it("新規作成の差分は --- /dev/null で始まり、全行が追加", () => {
    const diff = unifiedDiff("a.txt", null, "x\ny\n");
    expect(diff.split("\n").slice(0, 2)).toEqual(["--- /dev/null", "+++ b/a.txt"]);
    expect(countChanges(diff)).toEqual({ added: 2, removed: 0 });
  });

  it("編集は追加行と削除行に分かれ、差がなければ空文字", () => {
    const diff = unifiedDiff("a.txt", "1\n2\n3\n", "1\nX\n3\n");
    expect(classifyDiff(diff).filter((l) => l.kind === "add" || l.kind === "del")).toEqual([
      { kind: "del", text: "2" },
      { kind: "add", text: "X" },
    ]);
    expect(unifiedDiff("a.txt", "same\n", "same\n")).toBe("");
  });

  it("HTML はそのまま文字として扱い、ANSI は取り除く", () => {
    expect(classifyDiff("+<b>x</b>")[0]).toEqual({ kind: "add", text: "<b>x</b>" });
    expect(stripAnsi("\u001b[31mred\u001b[0m\r\nok\u001b]0;title\u0007")).toBe("red\nok");
  });
});
