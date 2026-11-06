import { describe, expect, it } from "vitest";
import { parseRoute } from "../src/router";

describe("ハッシュルーター（01_ia のルート）", () => {
  it.each([
    ["", { page: "threads", id: undefined }],
    ["#/threads", { page: "threads", id: undefined }],
    ["#/threads/abc", { page: "threads", id: "abc" }],
    ["#/setup", { page: "setup" }],
    ["#/models", { page: "models" }],
    ["#/presets/p1", { page: "presets", id: "p1" }],
    ["#/evals", { page: "evals", id: undefined }],
    ["#/evals/e1", { page: "evals", id: "e1" }],
    ["#/evals/e1/compare", { page: "compare", id: "e1" }],
    ["#/runs/r1", { page: "runs", id: "r1" }],
    ["#/settings", { page: "settings" }],
    ["#/unknown", { page: "threads", id: undefined }],
  ])("%s", (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });
});
