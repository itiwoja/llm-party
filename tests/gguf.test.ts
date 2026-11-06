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
      type: "model", architecture: "testarch", name: "Test Model", quantization: "Q4_K_M", trainContext: 32768,
    });
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
