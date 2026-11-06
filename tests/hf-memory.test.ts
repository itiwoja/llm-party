import { describe, expect, it } from "vitest";
import { estimateQ4Gb, fileNeedGb, fits } from "../server/hf/memory";

describe("目安メモリ", () => {
  it("9B の Q4_K_M は VRAM 8GB に収まる（D-59 の検証モデル）", () => {
    expect(estimateQ4Gb(9e9)).toBe(7);
    expect(fits(estimateQ4Gb(9e9), { vram: 8, ram: null })).toBe(true);
  });

  it("13B の Q4_K_M は VRAM 8GB に入らない", () => {
    expect(fits(estimateQ4Gb(13e9), { vram: 8, ram: null })).toBe(false);
    expect(fits(estimateQ4Gb(13e9), { vram: 16, ram: null })).toBe(true);
  });

  it("指定がなければ何でも通す。指定があるのに目安がなければ外す", () => {
    expect(fits(null, { vram: null, ram: null })).toBe(true);
    expect(fits(null, { vram: 8, ram: null })).toBe(false);
    expect(fits(null, { vram: null, ram: 8 })).toBe(false);
  });

  it("VRAM と RAM を両方指定したら、両方の上限を満たす", () => {
    expect(fits(6, { vram: 8, ram: 5 })).toBe(false);
    expect(fits(4, { vram: 8, ram: 5 })).toBe(true);
  });

  it("ファイルの目安は実サイズから（10 進の GB、文脈と作業分を 1.1 倍して 1GB 足す）", () => {
    expect(fileNeedGb(5e9)).toBe(6.5);
    expect(fileNeedGb(0)).toBe(1);
  });
});
