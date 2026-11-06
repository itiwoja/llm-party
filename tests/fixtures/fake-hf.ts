import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { writeGguf } from "../helpers";

/** 本物の GGUF の頭に、サイズ稼ぎの詰め物を付けたバイト列 */
export function ggufBytes(options: { type?: string; padding?: number } = {}): Buffer {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fake-hf-"));
  try {
    writeGguf(path.join(dir, "x.gguf"), { type: options.type });
    return Buffer.concat([readFileSync(path.join(dir, "x.gguf")), Buffer.alloc(options.padding ?? 0, 7)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface FakeFile {
  path: string;
  data: Buffer;
  /** tree に載せる sha256 を偽る */
  oid?: string;
  /** tree に載せるサイズを偽る（容量不足の試験） */
  reportedSize?: number;
}

export interface FakeRepo {
  files: FakeFile[];
  /** 付けるとゲート付き。resolve は Bearer がこの値のときだけ通る */
  gatedToken?: string;
}

export interface FakeHf {
  baseUrl: string;
  repos: Map<string, FakeRepo>;
  /** 試験ごとに書き換える挙動 */
  behavior: {
    ignoreRange: boolean;
    /** 次の CDN 応答を N バイトで切る回数分の列（先頭から消費） */
    cuts: number[];
    /** 次の resolve を 500 にする回数 */
    failures: number;
    treePageSize: number;
  };
  hfRequests: { url: string; authorization?: string; range?: string }[];
  cdnRequests: { url: string; authorization?: string; range?: string }[];
  close(): Promise<void>;
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Hugging Face の代役。resolve は別オリジンの CDN にリダイレクトする */
export async function startFakeHf(repos: Record<string, FakeRepo> = {}): Promise<FakeHf> {
  const fake: FakeHf = {
    baseUrl: "",
    repos: new Map(Object.entries(repos)),
    behavior: { ignoreRange: false, cuts: [], failures: 0, treePageSize: 1000 },
    hfRequests: [],
    cdnRequests: [],
    close: async () => undefined,
  };
  const note = (req: IncomingMessage) => ({ url: req.url ?? "", authorization: req.headers.authorization, range: req.headers.range });
  let cdnPort = 0;

  const json = (res: ServerResponse, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(200, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const hf = createServer((req, res) => {
    fake.hfRequests.push(note(req));
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/models") {
      const q = url.searchParams.get("search") ?? "";
      const items = [...fake.repos.keys()].filter((repo) => repo.includes(q)).map((repo, index) => ({
        id: repo, downloads: 1000 - index, lastModified: "2026-11-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", gated: Boolean(fake.repos.get(repo)!.gatedToken),
      }));
      return json(res, items);
    }
    const tree = /^\/api\/models\/([^/]+\/[^/]+)\/tree\/main$/.exec(url.pathname);
    if (tree) {
      const repo = fake.repos.get(tree[1]);
      if (!repo) return void res.writeHead(404).end();
      const entries = [
        { type: "directory", path: "sub" },
        { type: "file", path: "README.md", size: 10 },
        ...repo.files.map((file) => ({
          type: "file", path: file.path, size: 135, oid: "git-oid",
          lfs: { oid: file.oid ?? sha(file.data), size: file.reportedSize ?? file.data.length, pointerSize: 135 },
        })),
      ];
      const size = fake.behavior.treePageSize;
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const next = cursor + size;
      const headers: Record<string, string> = {};
      // 本物は続きを別ホスト名つきの絶対 URL で返す
      if (next < entries.length) headers.Link = `<https://huggingface.co${url.pathname}?recursive=true&cursor=${next}>; rel="next"`;
      return json(res, entries.slice(cursor, next), headers);
    }
    const resolve = /^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(url.pathname);
    if (resolve) {
      const repo = fake.repos.get(resolve[1]);
      const file = repo?.files.find((item) => item.path === decodeURIComponent(resolve[2]));
      if (!repo || !file) return void res.writeHead(404).end();
      if (repo.gatedToken && req.headers.authorization !== `Bearer ${repo.gatedToken}`) return void res.writeHead(401).end();
      if (fake.behavior.failures > 0) {
        fake.behavior.failures -= 1;
        return void res.writeHead(500).end();
      }
      res.writeHead(302, { Location: `http://127.0.0.1:${cdnPort}/blob/${encodeURIComponent(resolve[1])}/${resolve[2]}` });
      return void res.end();
    }
    res.writeHead(404).end();
  });

  const cdn = createServer((req, res) => {
    fake.cdnRequests.push(note(req));
    const match = /^\/blob\/([^/]+)\/(.+)$/.exec(req.url ?? "");
    const file = match && fake.repos.get(decodeURIComponent(match[1]))?.files.find((item) => item.path === decodeURIComponent(match[2]));
    if (!file) return void res.writeHead(404).end();
    const range = /^bytes=(\d+)-/.exec(req.headers.range ?? "");
    let start = 0;
    let status = 200;
    const headers: Record<string, string | number> = { "Accept-Ranges": "bytes" };
    if (range && !fake.behavior.ignoreRange) {
      start = Number(range[1]);
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${file.data.length - 1}/${file.data.length}`;
    }
    const body = file.data.subarray(start);
    headers["Content-Length"] = body.length;
    res.writeHead(status, headers);
    // 先頭1バイトだけの確認（POST 時の試し取り）では切らない
    const cut = req.headers.range === "bytes=0-0" ? undefined : fake.behavior.cuts.shift();
    if (cut === undefined || cut >= body.length) return void res.end(body);
    res.write(body.subarray(0, cut), () => setTimeout(() => res.destroy(), 20));
  });

  const hfPort = await listen(hf);
  cdnPort = await listen(cdn);
  fake.baseUrl = `http://127.0.0.1:${hfPort}`;
  fake.close = async () => {
    for (const server of [hf, cdn]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
  return fake;
}
