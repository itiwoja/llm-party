import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_LLAMA, startWorker, type TestWorker } from "./helpers";

let worker: TestWorker;
beforeEach(async () => {
  worker = await startWorker(FAKE_LLAMA);
});
afterEach(() => worker.close());

const patch = (body: unknown) => worker.api("/settings", { method: "PATCH", body });

describe("設定（API-090, 091）", () => {
  it("既定を返す", async () => {
    const res = await worker.api("/settings");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      modelsDir: path.join(worker.dir, "models"), defaultAutoApprove: false, defaultContextSize: 32768, theme: "system",
    });
    expect(res.body.modelsFreeBytes).toBeGreaterThan(0);
    expect(res.body.backend).toEqual(expect.any(String));
  });

  it("一部だけ更新して残りは変えない。再読み込みしても残る", async () => {
    const dir = path.join(worker.dir, "elsewhere");
    mkdirSync(dir);
    const res = await patch({ modelsDir: dir, theme: "dark" });
    expect(res.body).toMatchObject({ modelsDir: dir, theme: "dark", defaultAutoApprove: false, defaultContextSize: 32768 });
    expect((await patch({ defaultAutoApprove: true, defaultContextSize: 8192 })).body).toMatchObject({ modelsDir: dir, theme: "dark", defaultAutoApprove: true, defaultContextSize: 8192 });
    expect((await worker.api("/settings")).body).toMatchObject({ modelsDir: dir, defaultContextSize: 8192 });
    // models.ts と downloads.ts が読む形（JSON の文字列）
    const row = worker.context.db.prepare("SELECT value FROM settings WHERE key = 'modelsDir'").get() as { value: string };
    expect(row.value).toBe(JSON.stringify(dir));
    expect(worker.context.store.models.modelsDir(worker.dir)).toBe(dir);
  });

  it.each([
    [{ modelsDir: "relative/path" }],
    [{ modelsDir: "/no/such/dir/anywhere" }],
    [{ modelsDir: 5 }],
    [{ theme: "pink" }],
    [{ defaultAutoApprove: "yes" }],
    [{ defaultContextSize: 0 }],
    [{ defaultContextSize: 1.5 }],
    [{ backend: "cpu" }],
    [{ checkUpdatesOnStart: false }],
  ])("不正な値 %j は 400 で、何も変えない", async (body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect((await worker.api("/settings")).body.theme).toBe("system");
  });

  it("ファイルを modelsDir にはできない", async () => {
    const file = path.join(worker.dir, "afile");
    writeFileSync(file, "x");
    expect((await patch({ modelsDir: file })).status).toBe(400);
  });
});

describe("システム（API-021）", () => {
  it("パックは空で、置き場の空きを返す", async () => {
    const res = await worker.api("/system");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ packs: [], backend: expect.any(String) });
    expect(res.body.freeBytes).toBeGreaterThan(0);
  });
});

describe("診断 zip（API-092）", () => {
  it("ログ・版・設定を書き、秘密は含めない", async () => {
    const { dir } = worker;
    mkdirSync(path.join(dir, "secrets"), { recursive: true });
    writeFileSync(path.join(dir, "secrets", "hf-token"), "hf_SUPERSECRETTOKEN123");
    writeFileSync(path.join(dir, "local-token"), "LOCALTOKENVALUE999");
    mkdirSync(path.join(dir, "logs"), { recursive: true });
    writeFileSync(path.join(dir, "logs", "app-20261101.log"), "GET Authorization: Bearer abc.def-123 ok\nhf_SUPERSECRETTOKEN123 leaked\n");
    writeFileSync(path.join(dir, "logs", "llama-server-20261101.log"), "load ok\n");

    const target = path.join(dir, "diag.zip");
    const res = await worker.api("/diagnostics/export", { body: { path: target } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: target });

    const entries = unzipSync(new Uint8Array(readFileSync(target)));
    expect(Object.keys(entries).sort()).toEqual(["info.json", "logs/app-20261101.log", "logs/llama-server-20261101.log", "settings.json"]);
    const all = Object.values(entries).map((bytes) => new TextDecoder().decode(bytes)).join("\n");
    for (const secret of ["hf_SUPERSECRETTOKEN123", "LOCALTOKENVALUE999", "abc.def-123"]) {
      expect(all).not.toContain(secret);
    }
    expect(all).toContain("Bearer ***");
    expect(JSON.parse(new TextDecoder().decode(entries["info.json"]))).toMatchObject({ version: expect.any(String), backend: expect.any(String) });
  });

  it("相対パス・親フォルダがない場所は 400", async () => {
    expect((await worker.api("/diagnostics/export", { body: { path: "diag.zip" } })).status).toBe(400);
    expect((await worker.api("/diagnostics/export", { body: { path: path.join(worker.dir, "nope", "d.zip") } })).status).toBe(400);
  });
});
