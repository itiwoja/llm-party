import { describe, expect, it } from "vitest";
import { isModelFile } from "../src/pages/models/modelFile";

describe("HF のファイル一覧で「モデルだけを表示」に残すファイル", () => {
  it("モデル本体の GGUF は残す", () => {
    expect(isModelFile("GGUF/Q4-LynnStyle/Qwen3.8-27B-EfficientThink-SimPO-Q4-LynnStyle.gguf")).toBe(true);
    expect(isModelFile("GGUF/Q6_K/Qwen3.8-27B-EfficientThink-SimPO-Q6_K.gguf")).toBe(true);
  });
  it("mmproj・imatrix・mtp は外す", () => {
    expect(isModelFile("mmproj-model-f16.gguf")).toBe(false);
    expect(isModelFile("imatrix.gguf")).toBe(false);
    expect(isModelFile("sub/mtp-Qwen3.8-27B-Q8_0.gguf")).toBe(false);
  });
  it("dflash（先読みの下書きモデル）は外す", () => {
    expect(isModelFile("GGUF/Q8_0/dflash2-qwen38-27b-Q8_0.gguf")).toBe(false);
    expect(isModelFile("GGUF/Q2-LynnStyle/dflash2-qwen38-27b-Q4_K_M.gguf")).toBe(false);
    expect(isModelFile("Qwen3.8-27B-DFlash-Q4_K_M.gguf")).toBe(false);
  });
  it("GGUF 以外は外す", () => {
    expect(isModelFile("README.md")).toBe(false);
  });
});
