import { describe, expect, it } from "vitest";
import { REPEAT_LIMIT, RepeatGuard } from "../server/agent/repeat-guard";

const LINE = "こんにちは！何かお手伝いできることはありますか？長めの行";

describe("RepeatGuard（D-70）", () => {
  it("同じ行が上限の回数に達したら true", () => {
    const guard = new RepeatGuard();
    for (let i = 1; i < REPEAT_LIMIT; i++) expect(guard.feed(`${LINE}\n`)).toBe(false);
    expect(guard.feed(`${LINE}\n`)).toBe(true);
  });

  it("差分の境目で行が割れても数える", () => {
    const guard = new RepeatGuard();
    const text = `${LINE}\n`.repeat(REPEAT_LIMIT);
    const results = [...text].map((char) => guard.feed(char));
    expect(results.at(-1)).toBe(true);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("字下げや空白の違いは同じ行として数える", () => {
    const guard = new RepeatGuard();
    const line = "the same line   with enough length";
    for (let i = 1; i < REPEAT_LIMIT; i++) guard.feed(`  ${line}\n`);
    expect(guard.feed("the same line with enough length\n")).toBe(true);
  });

  it("短い行は何回出ても数えない", () => {
    const guard = new RepeatGuard();
    expect(guard.feed("Okay.\n".repeat(50))).toBe(false);
  });

  it("交互に出ても行ごとに数える", () => {
    const guard = new RepeatGuard();
    const other = "別の下書きの行で、長さは二十文字を超えています";
    expect(guard.feed(`${LINE}\n${other}\n`.repeat(REPEAT_LIMIT - 1))).toBe(false);
    expect(guard.feed(`${other}\n`)).toBe(true);
  });
});
