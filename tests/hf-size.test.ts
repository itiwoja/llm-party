import { describe, expect, it } from "vitest";
import { paramsFromName, sizeOf } from "../server/hf/client";

describe("HF のリポジトリのパラメータ数（VRAM 推奨の元）", () => {
  it("GGUF の値をそのまま使う", () => {
    expect(sizeOf({ id: "acme/x-9B-GGUF", gguf: { total: 9e9, architecture: "qwen3" } })).toEqual({ params: 9e9 });
  });
  it("HF が dflash（下書きモデル）を代表にしたときは名前から取る", () => {
    const item = { id: "nerkyor/Qwen3.8-27B-EfficientThink-SimPO-DFlash2-GGUF", gguf: { total: 1924404480, architecture: "dflash" } };
    expect(sizeOf(item)).toEqual({ params: 27e9 });
  });
  it("dflash で名前にも無ければ分からない扱い", () => {
    expect(sizeOf({ id: "acme/drafter-GGUF", gguf: { total: 1.9e9, architecture: "dflash" } })).toEqual({ params: null });
  });
  it("名前の B の数を読む", () => {
    expect(paramsFromName("Qwen/Qwen3-0.6B")).toBe(0.6e9);
    expect(paramsFromName("acme/Qwen3-30B-A3B-GGUF")).toBe(30e9);
    expect(paramsFromName("acme/Qwen3.8-GGUF")).toBeNull();
  });
});
