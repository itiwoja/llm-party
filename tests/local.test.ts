import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCTION_CSP } from "../server/csp";
import { localRoutes } from "../server/routes/local";
import { FAKE_LLAMA, startWorker, type TestWorker } from "./helpers";

describe("API-093 /api/local/info", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startWorker(FAKE_LLAMA, { extraRoutes: localRoutes });
  });
  afterEach(() => worker.close());

  it("版・データ・ログの場所を返す", async () => {
    const res = await worker.api("/local/info");
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    expect(res.body).toEqual({ version, llamaBuild: null, isPackaged: false, dataDir: worker.dir, logsDir: path.join(worker.dir, "logs") });
  });
});

describe("localhost の入口だけ", () => {
  it("extraRoutes を載せない worker には /api/local がない", async () => {
    const worker = await startWorker(FAKE_LLAMA);
    try {
      expect((await worker.api("/local/info")).status).toBe(404);
      expect((await worker.api("/local/hf-token")).status).toBe(404);
    } finally {
      await worker.close();
    }
  });
});

describe("npm start の CSP", () => {
  const directive = (name: string) => PRODUCTION_CSP.split(";").map((part) => part.trim().split(/\s+/)).find(([key]) => key === name)?.slice(1) ?? [];

  // 生成した画像・音声は blob: の URL で見せる。default-src にだけ頼ると画面に出ない
  it.each(["img-src", "media-src"])("%s は blob: を許す", (name) => {
    expect(directive(name)).toEqual(["'self'", "blob:"]);
  });

  it("基本は自分のオリジンだけのまま", () => {
    expect(directive("default-src")).toEqual(["'self'"]);
  });
});
