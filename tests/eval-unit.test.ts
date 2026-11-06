import { describe, expect, it } from "vitest";
import { gradeMatch, summarize } from "../server/eval/grade";
import { formatJsonl, parseJsonl } from "../server/eval/jsonl";
import { safeCaseName } from "../server/eval/service";

const match = (mode: "contains" | "exact" | "regex", expected: string, ignoreCase = false) => ({ type: "match" as const, mode, expected, ignoreCase });

describe("採点（FR-017）", () => {
  it("contains・exact・regex を判定する。ignoreCase は大文字小文字を無視", () => {
    expect(gradeMatch(match("contains", "ab"), "xxabxx").status).toBe("passed");
    expect(gradeMatch(match("contains", "AB"), "xxabxx").status).toBe("failed");
    expect(gradeMatch(match("contains", "AB", true), "xxabxx").status).toBe("passed");
    // exact は前後の空白だけ除く
    expect(gradeMatch(match("exact", "42"), "  42\n").status).toBe("passed");
    expect(gradeMatch(match("exact", "42"), "42 です").status).toBe("failed");
    expect(gradeMatch(match("exact", "Yes", true), " yes ").status).toBe("passed");
    expect(gradeMatch(match("regex", "(私|わたし)は"), "わたしは猫").status).toBe("passed");
    expect(gradeMatch(match("regex", "^abc$"), "ABC").status).toBe("failed");
    expect(gradeMatch(match("regex", "^abc$", true), "ABC").status).toBe("passed");
  });

  it("不正な正規表現は error", () => {
    const graded = gradeMatch(match("regex", "(未完"), "何か");
    expect(graded.status).toBe("error");
    expect(graded.error).toContain("正規表現");
  });
});

describe("正解率", () => {
  const result = (status: string, score: number | null = null, tokensPerSec: number | null = null) => ({ status, score, tokensPerSec });

  it("needs_review と skipped を分母から除く", () => {
    const stats = summarize([result("passed"), result("failed"), result("timed_out"), result("needs_review"), result("skipped"), result("error")]);
    expect(stats.passRate).toBe(1 / 4);
  });

  it("分母が 0 なら null。1to5 は平均点、速度は平均", () => {
    expect(summarize([result("needs_review"), result("skipped")]).passRate).toBeNull();
    const stats = summarize([result("passed", 5, 30), result("failed", 2, 10), result("needs_review")]);
    expect(stats).toEqual({ passRate: 0.5, avgScore: 3.5, avgTokensPerSec: 20 });
  });
});

describe("JSONL（FR-015）", () => {
  const ok = JSON.stringify({ name: "挨拶", kind: "chat", input: "自己紹介して", grader: { type: "match", mode: "contains", expected: "私" }, tags: ["日本語"] });

  it("正しい行だけ取り込み、不正な行は行番号と理由を返す。空行は飛ばす", () => {
    const text = [
      ok,
      "",
      "{壊れた",
      JSON.stringify({ name: "x", kind: "chat", input: "", grader: { type: "manual", scale: "pass_fail" } }),
      JSON.stringify({ name: "y", kind: "agent", input: "直して", grader: { type: "test", command: "true" } }),
      JSON.stringify({ name: "z", kind: "chat", input: "a", grader: { type: "test", command: "true" } }),
      JSON.stringify({ name: "w", kind: "agent", input: "a", fixture: "../外", grader: { type: "manual", scale: "1to5" } }),
      JSON.stringify({ name: "v", kind: "chat", input: "a", grader: { type: "match", mode: "fuzzy", expected: "a" } }),
    ].join("\r\n");
    const { cases, errors } = parseJsonl(text);
    expect(cases.map((item) => item.name)).toEqual(["挨拶"]);
    expect(errors.map((error) => error.line)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(errors[0].reason).toBe("JSON として読めません");
    expect(errors[1].reason).toContain("input");
    expect(errors[2].reason).toContain("fixture");
    expect(errors[3].reason).toContain("agent");
    expect(errors[4].reason).toContain("相対パス");
    expect(errors[5].reason).toContain("grader");
  });

  it("既定値を補い、書き出すと同じ内容を読み戻せる", () => {
    const { cases } = parseJsonl(ok);
    expect(cases[0]).toMatchObject({ grader: { ignoreCase: false }, tags: ["日本語"] });
    const again = parseJsonl(formatJsonl(cases));
    expect(again.errors).toEqual([]);
    expect(again.cases).toEqual(cases);
  });
});

describe("ケース名のフォルダ名", () => {
  it("区切り文字や .. を含んでも1階層の名前になり、別の名前は別の形になる", () => {
    for (const name of ["..", ".", "../x", "a/b", "a\\b", "日本語", "a b"]) {
      const safe = safeCaseName(name);
      expect(safe).toMatch(/^[A-Za-z0-9_~-]+$/);
      expect(safe).not.toContain("..");
    }
    const names = ["a/b", "a_b", "a~b", "a b", "a.b", "a-b"];
    expect(new Set(names.map(safeCaseName)).size).toBe(names.length);
    expect(safeCaseName("x".repeat(500)).length).toBeLessThanOrEqual(80);
    expect(safeCaseName("x".repeat(500))).not.toBe(safeCaseName("x".repeat(501)));
  });
});
