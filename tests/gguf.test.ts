import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGguf } from "../server/gguf";
import { tempDir, writeGguf } from "./helpers";

describe("readGguf", () => {
  let temp: ReturnType<typeof tempDir>;
  beforeEach(() => { temp = tempDir(); });
  afterEach(() => temp.remove());

  it("配列を読み飛ばして必要な値を取る", () => {
    const file = path.join(temp.dir, "m.gguf");
    writeGguf(file, { contextLength: 32768 });
    expect(readGguf(file)).toMatchObject({
      type: "model", architecture: "testarch", name: "Test Model", quantization: "Q4_K_M", trainContext: 32768, blockCount: 32,
    });
  });

  it.each([
    [undefined, false, false],
    ["{{ messages }}", false, false],
    ["{% if enable_thinking is defined %}", true, false],
    ["{{ reasoning_effort }}", false, true],
    ["{{ enable_thinking }}{{ reasoning_effort }}", true, true],
  ])("チャットテンプレートから思考の対応を読む（%s）", (chatTemplate, supportsThinking, supportsEffort) => {
    const file = path.join(temp.dir, "t.gguf");
    writeGguf(file, { chatTemplate });
    expect(readGguf(file)).toMatchObject({ supportsThinking, supportsEffort });
  });

  it("最後の nextn 層しか持たない GGUF は MTP（先読みの補助部分）だけとみなす", () => {
    const file = path.join(temp.dir, "mtp-m.gguf");
    writeGguf(file, { nextn: 1, tensors: ["token_embd.weight", "blk.31.attn_q.weight", "output.weight"] });
    expect(readGguf(file).type).toBe("mtp");
  });

  it("MTP の層を含んでいても、本体の層があればモデル", () => {
    const file = path.join(temp.dir, "m.gguf");
    writeGguf(file, { nextn: 1, tensors: ["token_embd.weight", "blk.0.attn_q.weight", "blk.31.attn_q.weight"] });
    expect(readGguf(file).type).toBe("model");
  });

  it("GGUF でなければ INVALID_GGUF", () => {
    const file = path.join(temp.dir, "x.gguf");
    writeFileSync(file, "this is not a gguf file at all!!");
    expect(() => readGguf(file)).toThrow("GGUF ファイルではありません");
  });

  it("途中で切れたファイルは INVALID_GGUF", () => {
    const file = path.join(temp.dir, "m.gguf");
    writeGguf(file);
    const whole = readFileSync(file);
    writeFileSync(file, whole.subarray(0, 40));
    expect(() => readGguf(file)).toThrow("GGUF を読めません");
  });
});
