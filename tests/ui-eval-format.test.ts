import { describe, expect, it } from "vitest";
import { clockText, percentText, secondsText, speedText } from "../src/pages/runs/format";

describe("評価画面の数字の表記（FR-018）", () => {
  it("合計時間は分:秒、1 時間を超えたら時:分:秒", () => {
    expect(clockText(725_000)).toBe("12:05");
    expect(clockText(3_725_000)).toBe("1:02:05");
    expect(clockText(0)).toBe("00:00");
  });
  it("正解率・速度は小数 1 桁、値がなければ —", () => {
    expect(percentText(0.85)).toBe("85.0%");
    expect(percentText(null)).toBe("—");
    expect(speedText(41.23)).toBe("41.2");
    expect(speedText(null)).toBe("—");
  });
  it("ケースの時間は秒", () => {
    expect(secondsText(42_400)).toBe("42s");
    expect(secondsText(null)).toBe("—");
  });
});
