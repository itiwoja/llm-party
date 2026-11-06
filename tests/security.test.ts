import { request } from "node:http";
import { statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOrCreateToken } from "../server/token";
import { startWorker, tempDir, TOKEN, type TestWorker } from "./helpers";

let worker: TestWorker;
let port: number;

/** fetch は Host を書き換えられないので http.request で送る */
function get(headers: Record<string, string>, pathname = "/api/health") {
  return new Promise<number>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

beforeAll(async () => {
  worker = await startWorker(null);
  port = worker.port;
});

afterAll(() => worker.close());

describe("API の入口", () => {
  const host = () => `127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  it("正しいトークンなら通す", async () => {
    expect(await get({ ...auth, Host: host() })).toBe(200);
    expect(await get({ ...auth, Host: `localhost:${port}` })).toBe(200);
  });

  it("トークンがない・違うと 401", async () => {
    expect(await get({ Host: host() })).toBe(401);
    expect(await get({ Authorization: "Bearer wrong!", Host: host() })).toBe(401);
  });

  it("他のホスト名は断る（DNS リバインディング）", async () => {
    expect(await get({ ...auth, Host: `evil.example:${port}` })).toBe(403);
  });

  it("他のオリジンは断る。CORS ヘッダーも返さない", async () => {
    expect(await get({ ...auth, Host: host(), Origin: "https://evil.example" })).toBe(403);
    expect(await get({ ...auth, Host: host(), Origin: `http://${host()}` })).toBe(200);
  });

  it("未定義の API は 404", async () => {
    expect(await get({ ...auth, Host: host() }, "/api/none")).toBe(404);
  });
});

describe("接続トークン", () => {
  it("権限 600 で作り、次回も同じ値を使う", () => {
    const { dir, remove } = tempDir();
    try {
      const first = loadOrCreateToken(dir);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(loadOrCreateToken(dir)).toBe(first);
      expect(statSync(path.join(dir, "local-token")).mode & 0o777).toBe(0o600);
    } finally {
      remove();
    }
  });
});
