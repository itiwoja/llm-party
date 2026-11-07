import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLlama } from "../server/runtime/installer";
import type { LlamaFlavor, RuntimeAsset } from "../server/runtime/manifest";
import { ignoredOverrideWarning, installDirFor, resolveLlama } from "../server/runtime/resolver";
import { tempDir } from "./helpers";

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("resolveLlama", () => {
  let temp: ReturnType<typeof tempDir>;
  beforeEach(() => { temp = tempDir(); });
  afterEach(() => temp.remove());

  it("上書きのパスがあれば、それを使う", () => {
    const bin = path.join(temp.dir, "my-llama");
    writeFileSync(bin, "");
    expect(resolveLlama({ override: bin, dataDir: temp.dir, flavor: "cpu" })).toEqual({ status: "override", bin });
  });

  it("上書きのパスが実在しなければ無視して、指定がないときと同じに解決する（ADR-012）", () => {
    const none = resolveLlama({ override: null, dataDir: temp.dir, flavor: "cpu" });
    expect(resolveLlama({ override: "/no/such/llama-server", dataDir: temp.dir, flavor: "cpu" })).toEqual(none);
    expect(none.status).toBe("missing");

    const dir = installDirFor(temp.dir, "cpu");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "llama-server"), "");
    expect(resolveLlama({ override: "/no/such/llama-server", dataDir: temp.dir, flavor: "cpu" })).toEqual({ status: "installed", bin: path.join(dir, "llama-server"), flavor: "cpu" });
  });

  it("名前だけの指定は、そのまま override で返す", () => {
    expect(resolveLlama({ override: "llama-server", dataDir: temp.dir, flavor: "cpu" })).toEqual({ status: "override", bin: "llama-server" });
  });

  it("取得済みの llama-server があれば installed", () => {
    const dir = installDirFor(temp.dir, "cuda");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "llama-server"), "");
    expect(resolveLlama({ override: null, dataDir: temp.dir, flavor: "cuda" })).toEqual({ status: "installed", bin: path.join(dir, "llama-server"), flavor: "cuda" });
  });

  it("無ければ missing で、取得先のフォルダを返す", () => {
    const res = resolveLlama({ override: null, dataDir: temp.dir, flavor: "cpu" });
    expect(res).toEqual({ status: "missing", flavor: "cpu", installDir: installDirFor(temp.dir, "cpu") });
  });
});

describe("ignoredOverrideWarning", () => {
  it("指定なし・実在するパス・名前だけは null", () => {
    expect(ignoredOverrideWarning(null)).toBeNull();
    expect(ignoredOverrideWarning(process.execPath)).toBeNull();
    expect(ignoredOverrideWarning("llama-server")).toBeNull();
  });

  it("実在しないパスなら CP-313 の文", () => {
    expect(ignoredOverrideWarning("/no/such/llama-server")).toBe(
      "LLM_PARTY_LLAMA_BIN のパスが見つからないので、指定を無視しました: /no/such/llama-server。起動コマンドから外すと消えます",
    );
  });
});

describe("installLlama", () => {
  let temp: ReturnType<typeof tempDir>;
  let server: http.Server | null = null;
  let base = "";

  beforeEach(() => { temp = tempDir(); });
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    temp.remove();
  });

  /** 本物と同じ形の小さな tar.gz を作る。files は top フォルダからの相対パス */
  function makeArchive(name: string, top: string, files: Record<string, string>): string {
    const src = path.join(temp.dir, top);
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(src, file);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    const archive = path.join(temp.dir, name);
    execFileSync("tar", ["-czf", archive, "-C", temp.dir, top]);
    return archive;
  }

  /** 本物の形：先頭の階層（llama-b1/）の中に llama-server と .so */
  function makeLlamaArchive(name: string): string {
    return makeArchive(name, "llama-b1", { "llama-server": "#!/bin/sh\necho llama-server\n", "libllama.so.0": "so" });
  }

  function serve(files: Map<string, Buffer>): Promise<void> {
    server = http.createServer((req, res) => {
      const body = files.get(req.url ?? "");
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Length": body.length });
      res.end(body);
    });
    return new Promise((resolve) => server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve();
    }));
  }

  function flavorFor(archive: string, extras: { name: string; path: string }[] = []): LlamaFlavor {
    const asset = (file: string): RuntimeAsset => ({
      name: path.basename(file),
      size: readFileSync(file).length,
      sha256: sha(file),
      url: `${base}/${path.basename(file)}`,
    });
    return {
      id: "cpu",
      dirName: "test-cpu",
      archive: asset(archive),
      extras: extras.map((e) => asset(e.path)),
    };
  }

  it("取得して展開し、llama-server を置く（先頭の階層は外す）", async () => {
    const archive = makeLlamaArchive("llama.tar.gz");
    await serve(new Map([["/llama.tar.gz", readFileSync(archive)]]));
    const progress: number[] = [];
    const bin = await installLlama({
      dataDir: temp.dir, flavor: "cpu", signal: new AbortController().signal,
      onProgress: (p) => progress.push(p), source: flavorFor(archive),
    });
    expect(bin).toBe(path.join(installDirFor(temp.dir, "cpu"), "llama-server"));
    expect(existsSync(bin)).toBe(true);
    expect(progress[progress.length - 1]).toBe(100);
    // 取得の途中のフォルダは残らない
    expect(existsSync(path.join(temp.dir, "runtime", "llama", ".downloads"))).toBe(false);
  });

  it("CUDA の cudart は、中がどんな階層でも .so を llama-server と同じフォルダへ置く", async () => {
    const archive = makeLlamaArchive("llama.tar.gz");
    const cudart = makeArchive("cudart.tar.gz", "cudart-top", { "lib/libcudart.so.12": "cuda", "lib/libcublas.so.12": "cublas" });
    await serve(new Map([["/llama.tar.gz", readFileSync(archive)], ["/cudart.tar.gz", readFileSync(cudart)]]));
    const flavor = flavorFor(archive, [{ name: "cudart.tar.gz", path: cudart }]);
    const bin = await installLlama({
      dataDir: temp.dir, flavor: "cuda", signal: new AbortController().signal, onProgress: () => {},
      source: { ...flavor, id: "cuda" }, skipDeviceCheck: true,
    });
    const dir = path.dirname(bin);
    expect(existsSync(path.join(dir, "libcudart.so.12"))).toBe(true);
    expect(existsSync(path.join(dir, "libcublas.so.12"))).toBe(true);
  });

  it("sha256 が違えば、最終フォルダは作らずに失敗する", async () => {
    const archive = makeLlamaArchive("llama.tar.gz");
    await serve(new Map([["/llama.tar.gz", readFileSync(archive)]]));
    const flavor = flavorFor(archive);
    flavor.archive.sha256 = "0".repeat(64);
    await expect(installLlama({
      dataDir: temp.dir, flavor: "cpu", signal: new AbortController().signal, onProgress: () => {}, source: flavor,
    })).rejects.toThrow(/壊れていました|試しました/);
    expect(existsSync(installDirFor(temp.dir, "cpu"))).toBe(false);
  });

  it("上限（1GB）を超える取得は、DL の前に断る", async () => {
    const archive = makeLlamaArchive("llama.tar.gz");
    const flavor = flavorFor(archive);
    flavor.archive.size = 2 * 1024 ** 3;
    await expect(installLlama({
      dataDir: temp.dir, flavor: "cpu", signal: new AbortController().signal, onProgress: () => {}, source: flavor,
    })).rejects.toThrow(/上限/);
  });

  it("中断されたら止まる", async () => {
    const archive = makeLlamaArchive("llama.tar.gz");
    await serve(new Map([["/llama.tar.gz", readFileSync(archive)]]));
    const controller = new AbortController();
    controller.abort();
    await expect(installLlama({
      dataDir: temp.dir, flavor: "cpu", signal: controller.signal, onProgress: () => {}, source: flavorFor(archive),
    })).rejects.toThrow();
    expect(existsSync(installDirFor(temp.dir, "cpu"))).toBe(false);
  });
});
