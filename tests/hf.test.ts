import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localRoutes } from "../server/routes/local";
import { ggufBytes, startFakeHf, type FakeHf } from "./fixtures/fake-hf";
import { FAKE_LLAMA, startWorker, type TestWorker } from "./helpers";

const data = ggufBytes({ padding: 100 });
let hf: FakeHf;
let worker: TestWorker;

beforeEach(async () => {
  hf = await startFakeHf({
    "acme/tiny-GGUF": {
      files: [
        { path: "tiny-Q4_K_M.gguf", data },
        { path: "tiny-Q8_0.gguf", data },
        { path: "tiny-BF16-00002-of-00002.gguf", data },
        { path: "tiny-BF16-00001-of-00002.gguf", data },
        { path: "sub/tiny-Q2_K.gguf", data },
      ],
    },
    "acme/lonely-GGUF": { files: [{ path: "lonely-Q4_K_M-00002-of-00003.gguf", data }, { path: "lonely-Q4_K_M-00003-of-00003.gguf", data }] },
    "acme/gated-GGUF": { gatedToken: "hf_secret", files: [{ path: "g-Q4_K_M.gguf", data }] },
  });
  worker = await startWorker(FAKE_LLAMA, { hfBaseUrl: hf.baseUrl, extraRoutes: localRoutes });
});

afterEach(async () => {
  await worker.close();
  await hf.close();
});

describe("API-053 検索", () => {
  it("名前・DL 数・更新日を返す", async () => {
    const res = await worker.api("/hf/search?q=tiny");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { repo: "acme/tiny-GGUF", downloads: 1000, updatedAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", gated: false },
    ]);
    const search = new URL(`http://x${hf.hfRequests.at(-1)!.url}`).searchParams;
    expect(Object.fromEntries(search)).toEqual({ search: "tiny", filter: "gguf", sort: "downloads", limit: "20" });
  });

  it("空の語は 400", async () => {
    expect((await worker.api("/hf/search?q=")).status).toBe(400);
  });

  it("HF が落ちていれば 502", async () => {
    await hf.close();
    const res = await worker.api("/hf/search?q=tiny");
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("UPSTREAM_ERROR");
    hf = await startFakeHf();
  });
});

describe("API-054 ファイル一覧", () => {
  it("分割をまとめ、量子化とサイズを出す", async () => {
    const res = await worker.api("/hf/files?repo=acme/tiny-GGUF");
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.items.map((item: any) => [item.name, item]));
    expect(Object.keys(byName).sort()).toEqual(["sub/tiny-Q2_K.gguf", "tiny-BF16-00001-of-00002.gguf", "tiny-Q4_K_M.gguf", "tiny-Q8_0.gguf"]);
    expect(byName["tiny-BF16-00001-of-00002.gguf"]).toMatchObject({ split: true, complete: true, quantization: "BF16", sizeBytes: data.length * 2 });
    expect(byName["tiny-BF16-00001-of-00002.gguf"].parts.map((part: any) => part.name)).toEqual([
      "tiny-BF16-00001-of-00002.gguf", "tiny-BF16-00002-of-00002.gguf",
    ]);
    expect(byName["tiny-Q4_K_M.gguf"]).toMatchObject({ split: false, quantization: "Q4_K_M", sizeBytes: data.length });
    expect(byName["sub/tiny-Q2_K.gguf"].quantization).toBe("Q2_K");
  });

  it("tree が複数ページでも全部集める（Link の next を辿る）", async () => {
    hf.behavior.treePageSize = 2;
    const res = await worker.api("/hf/files?repo=acme/tiny-GGUF");
    expect(res.body.items).toHaveLength(4);
    const pages = hf.hfRequests.filter((request) => request.url.includes("/tree/main"));
    expect(pages.length).toBeGreaterThan(1);
  });

  it("先頭がない分割は complete: false", async () => {
    const res = await worker.api("/hf/files?repo=acme/lonely-GGUF");
    expect(res.body.items[0]).toMatchObject({ split: true, complete: false });
  });

  it("ない repo は 404、形が不正なら 400", async () => {
    expect((await worker.api("/hf/files?repo=acme/none")).status).toBe(404);
    for (const repo of ["..%2Fx", "a", "a/b/c", "../etc", "/abs/path", "a/.."]) {
      expect((await worker.api(`/hf/files?repo=${repo}`)).status, repo).toBe(400);
    }
  });
});

describe("入力の検査（パストラバーサル）", () => {
  const bad = ["../evil.gguf", "/etc/x.gguf", "a/../../x.gguf", "x.txt", "a\\b.gguf", "a//b.gguf", ""];
  it.each(bad)("ファイル名 %j を拒否する", async (file) => {
    const res = await worker.api("/downloads", { body: { repo: "acme/tiny-GGUF", files: [file], kind: "model" } });
    expect(res.status).toBe(400);
  });
  it.each(["../x/y", "acme/../x", "/abs/x", "acme", "a b/c"])("repo %j を拒否する", async (repo) => {
    const res = await worker.api("/downloads", { body: { repo, files: ["tiny-Q4_K_M.gguf"], kind: "model" } });
    expect(res.status).toBe(400);
  });
  it("ツリーにないファイルは 400", async () => {
    const res = await worker.api("/downloads", { body: { repo: "acme/tiny-GGUF", files: ["nothing.gguf"], kind: "model" } });
    expect(res.status).toBe(400);
  });
  it("拒否した後に DL の行も作らない", async () => {
    await worker.api("/downloads", { body: { repo: "acme/tiny-GGUF", files: ["../evil.gguf"], kind: "model" } });
    expect((await worker.api("/downloads")).body.items).toEqual([]);
  });
});

describe("API-094 HF トークン", () => {
  const file = () => path.join(worker.dir, "secrets", "hf-token");

  it("GET は { has } だけ返し、PUT でトークンの値は返らない", async () => {
    expect((await worker.api("/local/hf-token")).body).toEqual({ has: false });
    const put = await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_secret" } });
    expect(put.body).toEqual({ has: true });
    const get = await worker.api("/local/hf-token");
    expect(get.body).toEqual({ has: true });
    expect(JSON.stringify([put.body, get.body])).not.toContain("hf_secret");
  });

  it("ファイルの権限は 600（既存ファイルを上書きしても）", async () => {
    await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_secret" } });
    expect(readFileSync(file(), "utf8")).toBe("hf_secret");
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_other" } });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("null で消える。改行や空の値は 400", async () => {
    await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_secret" } });
    expect((await worker.api("/local/hf-token", { method: "PUT", body: { token: null } })).body).toEqual({ has: false });
    expect(existsSync(file())).toBe(false);
    for (const token of ["", "a b", "a\nb", 5]) {
      expect((await worker.api("/local/hf-token", { method: "PUT", body: { token } })).status, String(token)).toBe(400);
    }
  });
});

describe("ゲート付きリポジトリ", () => {
  const body = { repo: "acme/gated-GGUF", files: ["g-Q4_K_M.gguf"], kind: "model" };

  it("トークンなしは 401 AUTH_REQUIRED_UPSTREAM", async () => {
    const res = await worker.api("/downloads", { body });
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: "AUTH_REQUIRED_UPSTREAM", message: "ゲート付きリポジトリ。設定で HF トークンが必要" });
  });

  it("間違ったトークンも 401", async () => {
    await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_wrong" } });
    expect((await worker.api("/downloads", { body })).status).toBe(401);
  });

  it("正しいトークンなら受け付ける。トークンは HF にだけ付き、CDN へのリダイレクトでは落ちる", async () => {
    await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_secret" } });
    const res = await worker.api("/downloads", { body });
    expect(res.status).toBe(202);
    expect(hf.hfRequests.some((request) => request.authorization === "Bearer hf_secret")).toBe(true);
    const resolved = hf.hfRequests.filter((request) => request.url.includes("/resolve/"));
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every((request) => request.authorization === "Bearer hf_secret")).toBe(true);
    expect(hf.cdnRequests.length).toBeGreaterThan(0);
    expect(hf.cdnRequests.every((request) => request.authorization === undefined)).toBe(true);
  });
});
