import { describe, expect, it } from "vitest";
import { usableAs } from "../server/hf/usable";

/** HF の検索結果の1件。チャットに使える条件を全部満たす */
const chatRepo = (patch: Record<string, unknown> = {}) => ({
  id: "acme/tiny-GGUF",
  pipeline_tag: "text-generation",
  gguf: { architecture: "qwen3", chat_template: "{{ messages }}" },
  siblings: [{ rfilename: "tiny-Q4_K_M.gguf" }],
  ...patch,
});

describe("usableAs の library_name", () => {
  it.each([undefined, null, "gguf", "llama.cpp", "transformers"])("%s ならチャットに使える", (library_name) => {
    expect(usableAs(chatRepo({ library_name }))).toBe("chat");
  });

  it.each(["strata", "mlx", "vllm"])("%s は別のツール専用なので出さない", (library_name) => {
    expect(usableAs(chatRepo({ library_name }))).toBeNull();
  });

  it("llama.cpp にある形式を名乗っていても、Strata 向けの切り出し GGUF は出さない", () => {
    expect(usableAs(chatRepo({ id: "x/OrcaRouter-NVFP4-GPTQ-Strata", library_name: "strata", gguf: { architecture: "qwen4exp", chat_template: "{{ messages }}" } }))).toBeNull();
  });
});
