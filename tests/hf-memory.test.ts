import { describe, expect, it } from "vitest";
import { fits, memoryNeed, q4Bytes } from "../server/hf/memory";

describe("目安メモリ", () => {
  it("9B の Q4_K_M を全部 GPU に載せると VRAM 8GB に収まる（D-59 の検証モデル）", () => {
    expect(memoryNeed(q4Bytes(9e9)).vramGb).toBe(7);
    expect(fits(memoryNeed(q4Bytes(9e9)), { vram: 8, ram: null })).toBe(true);
  });

  it("13B の Q4_K_M を全部 GPU に載せると VRAM 8GB に入らない", () => {
    expect(fits(memoryNeed(q4Bytes(13e9)), { vram: 8, ram: null })).toBe(false);
    expect(fits(memoryNeed(q4Bytes(13e9)), { vram: 16, ram: null })).toBe(true);
  });

  it("割合で VRAM と RAM に分ける（10 進の GB、1.1 倍して、VRAM に 1GB、RAM に 4GB）", () => {
    expect(memoryNeed(5e9, 100)).toEqual({ vramGb: 6.5, ramGb: 4 });
    expect(memoryNeed(5e9, 60)).toEqual({ vramGb: 4.3, ramGb: 6.2 });
  });

  it("GPU を使わないと VRAM は 0 で、作業用の 1GB も RAM に移る", () => {
    expect(memoryNeed(5e9, 0)).toEqual({ vramGb: 0, ramGb: 10.5 });
  });

  it("割合を省くと全部 GPU に載せた値", () => {
    expect(memoryNeed(5e9)).toEqual(memoryNeed(5e9, 100));
  });

  it("指定がなければ何でも通す。指定があるのに目安がなければ外す", () => {
    expect(fits(null, { vram: null, ram: null })).toBe(true);
    expect(fits(null, { vram: 8, ram: null })).toBe(false);
    expect(fits(null, { vram: null, ram: 8 })).toBe(false);
  });

  it("VRAM は VRAM の目安と、RAM は RAM の目安と比べる", () => {
    const need = { vramGb: 2, ramGb: 6 };
    expect(fits(need, { vram: 4, ram: null })).toBe(true);
    expect(fits(need, { vram: null, ram: 4 })).toBe(false);
    expect(fits(need, { vram: 4, ram: 6 })).toBe(true);
    expect(fits(need, { vram: 1, ram: 6 })).toBe(false);
  });
});
