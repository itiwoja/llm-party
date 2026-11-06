import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
