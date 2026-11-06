import { describe, expect, it } from "vitest";
import { distinctLabels } from "../src/pages/models/fileLabel";

describe("HF のファイル名の違う部分（同じ名前の並び）", () => {
  it("共通の前後を外し、区切りの位置で切る", () => {
    expect(
      distinctLabels([
        "moss-te-heretic-dhq-IQ-4.2G.gguf",
        "moss-te-only-dhq-IQ-2.9G.gguf",
        "moss-te-heretic-dhq-K-3.9G.gguf",
      ]),
    ).toEqual(["heretic-dhq-IQ-4.2G", "only-dhq-IQ-2.9G", "heretic-dhq-K-3.9G"]);
  });
  it("語の途中では切らない", () => {
    expect(distinctLabels(["model-Q4_K_M.gguf", "model-Q5_K_M.gguf"])).toEqual(["Q4", "Q5"]);
  });
  it("分割の番号など全部に共通する部分は外れる", () => {
    expect(distinctLabels(["a-x-00001-of-00002.gguf", "a-y-00001-of-00002.gguf"])).toEqual(["x", "y"]);
  });
  it("1 件だけ・違いが取れないときは拡張子を除いた名前", () => {
    expect(distinctLabels(["only-one.gguf"])).toEqual(["only-one"]);
    expect(distinctLabels(["same.gguf", "same.gguf"])).toEqual(["same", "same"]);
  });
});
