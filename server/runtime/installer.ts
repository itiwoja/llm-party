import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, open, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../http-error";
import { DOWNLOAD_RETRIES, LLAMA_FLAVORS, MAX_INSTALL_BYTES, type LlamaFlavor, type RuntimeAsset } from "./manifest";
import { installDirFor } from "./resolver";

/** DL の途中の失敗（接続切れなど）。再試行の対象 */
class RetryableError extends Error {}

const FREE_MARGIN = 2 * 1024 ** 3;
const BROKEN_MESSAGE = "ファイルが壊れていました。再試行してください";

export interface InstallInput {
  dataDir: string;
  flavor: LlamaFlavor["id"];
  signal: AbortSignal;
  /** 0〜100 の整数。増えたときだけ呼ぶ */
  onProgress: (percent: number) => void;
  /** テスト用：取得元を差し替える（省略時は manifest の値） */
  source?: LlamaFlavor;
  /** テスト用：CUDA の --list-devices 確認を省く */
  skipDeviceCheck?: boolean;
}

/**
 * llama-server を取得して置く（ADR-011）。戻り値は llama-server の絶対パス。
 * 取得済みなら DL せずにそのパスを返す。途中で失敗しても最終フォルダには残さない。
 */
export async function installLlama(input: InstallInput): Promise<string> {
  const flavor = input.source ?? LLAMA_FLAVORS[input.flavor];
  const finalDir = installDirFor(input.dataDir, flavor.id);
  const finalBin = path.join(finalDir, "llama-server");
  if (existsSync(finalBin)) return finalBin;

  const assets = [flavor.archive, ...flavor.extras];
  const total = assets.reduce((sum, a) => sum + a.size, 0);
  if (total > MAX_INSTALL_BYTES) throw new ApiError("INSUFFICIENT_STORAGE", "取得するファイルが上限（1GB）を超えています");
  await ensureSpace(input.dataDir, total);

  const runtimeDir = path.join(input.dataDir, "runtime", "llama");
  const downloads = path.join(runtimeDir, ".downloads");
  const tmpDir = path.join(runtimeDir, `.tmp-${flavor.dirName}`);
  mkdirSync(downloads, { recursive: true });
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    // 進捗：ファイルごとの取得済みバイト数を持ち、その合計を全体に対する割合にする（再試行で二重に数えない）
    const got = new Map<string, number>();
    let lastPercent = -1;
    const report = (name: string, bytes: number) => {
      got.set(name, bytes);
      let sum = 0;
      for (const value of got.values()) sum += value;
      const percent = Math.min(100, Math.floor((sum * 100) / total));
      if (percent !== lastPercent) {
        lastPercent = percent;
        input.onProgress(percent);
      }
    };

    const archivePath = path.join(downloads, flavor.archive.name);
    const extraPaths = flavor.extras.map((a) => path.join(downloads, a.name));
    await fetchAsset(flavor.archive, archivePath, input.signal, report);
    for (let i = 0; i < flavor.extras.length; i++) await fetchAsset(flavor.extras[i], extraPaths[i], input.signal, report);

    // 本体：アーカイブの中の llama-b<版>/ を1段はがして置く（実物で確かめた形）
    await extractTar(archivePath, tmpDir, 1);
    if (!existsSync(path.join(tmpDir, "llama-server"))) throw new Error("取得したアーカイブに llama-server が入っていませんでした");

    // cudart：展開先の形は決め打ちせず、中の .so を llama-server と同じフォルダへ集める
    for (const extra of extraPaths) {
      const extraDir = path.join(tmpDir, ".extra", path.basename(extra));
      await mkdir(extraDir, { recursive: true });
      await extractTar(extra, extraDir, 0);
      for (const so of findSharedLibraries(extraDir)) await copyFile(so, path.join(tmpDir, path.basename(so)));
      await rm(path.join(tmpDir, ".extra"), { recursive: true, force: true });
    }

    if (flavor.id === "cuda" && !input.skipDeviceCheck) {
      const ok = await listsCudaDevices(path.join(tmpDir, "llama-server"));
      if (!ok) {
        await rm(tmpDir, { recursive: true, force: true });
        throw new ApiError("ENGINE_FAILED", "CUDA の GPU が見えませんでした。NVIDIA ドライバを更新してください");
      }
    }

    await rm(finalDir, { recursive: true, force: true });
    await mkdir(path.dirname(finalDir), { recursive: true });
    await rename(tmpDir, finalDir);
    await rm(path.join(runtimeDir, ".downloads"), { recursive: true, force: true });
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
  return finalBin;
}

async function ensureSpace(dir: string, total: number): Promise<void> {
  let target = path.resolve(dir);
  while (!existsSync(target)) target = path.dirname(target);
  const stats = await statfs(target);
  const free = stats.bavail * stats.bsize;
  if (free < total + FREE_MARGIN) {
    throw new ApiError("INSUFFICIENT_STORAGE", `空き容量不足。${((total + FREE_MARGIN) / 1e9).toFixed(1)} GB 必要`);
  }
}

/** 1ファイルを .part に取る。続きから取り、サイズと sha256 を照合する。失敗は再試行（DOWNLOAD_RETRIES 回まで） */
async function fetchAsset(asset: RuntimeAsset, dest: string, signal: AbortSignal, report: (name: string, bytes: number) => void): Promise<void> {
  if (existsSync(dest) && statSync(dest).size === asset.size && (await sha256(dest)) === asset.sha256) {
    report(asset.name, asset.size);
    return;
  }
  const part = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      await download(asset, part, signal, (bytes) => report(asset.name, bytes));
      if (statSync(part).size !== asset.size || (await sha256(part)) !== asset.sha256) {
        await rm(part, { force: true });
        throw new RetryableError(BROKEN_MESSAGE);
      }
      await rename(part, dest);
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      if (!(error instanceof RetryableError)) throw error;
      if (attempt >= DOWNLOAD_RETRIES) throw new ApiError("UPSTREAM_ERROR", `${error.message}（${attempt} 回試しました）`);
    }
  }
}

/** .part の続きから取る。bytes は、このファイルの取得済みの絶対バイト数 */
async function download(asset: RuntimeAsset, part: string, signal: AbortSignal, bytesSoFar: (bytes: number) => void): Promise<void> {
  let existing = existsSync(part) ? statSync(part).size : 0;
  if (existing > asset.size) {
    await rm(part, { force: true });
    existing = 0;
  }
  if (existing === asset.size) {
    bytesSoFar(existing);
    return;
  }
  const headers: Record<string, string> = existing > 0 ? { Range: `bytes=${existing}-` } : {};
  const res = await fetch(asset.url, { headers, redirect: "follow", signal });
  if (res.status === 416) {
    await res.body?.cancel();
    await rm(part, { force: true });
    throw new RetryableError("範囲が合いません");
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new RetryableError(`ダウンロードに失敗しました（HTTP ${res.status}）`);
  }
  let append = false;
  if (res.status === 206) {
    const start = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1];
    if (Number(start) !== existing) {
      await res.body.cancel();
      await rm(part, { force: true });
      throw new RetryableError("範囲が合いません");
    }
    append = true;
  } else {
    // Range を無視されたら最初から書く
    existing = 0;
  }
  bytesSoFar(existing);
  const handle = await open(part, append ? "a" : "w");
  let written = existing;
  try {
    const reader = res.body.getReader();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new RetryableError("接続が切れました");
      }
      if (chunk.done) break;
      await handle.write(chunk.value);
      written += chunk.value.length;
      bytesSoFar(written);
    }
  } finally {
    await handle.close();
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** tar -xzf。strip は先頭の階層を捨てる数 */
function extractTar(archive: string, dest: string, strip: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", dest, `--strip-components=${strip}`], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`展開に失敗しました（tar ${code}）: ${stderr.trim().slice(0, 200)}`));
    });
  });
}

function findSharedLibraries(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findSharedLibraries(full));
    else if (/\.so(\.|$)/.test(entry.name)) found.push(full);
  }
  return found;
}

/** --list-devices で CUDA のデバイスが見えるか（FR-002 の確認） */
function listsCudaDevices(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ["--list-devices"], { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve(!error && /CUDA/i.test(`${stdout}\n${stderr}`));
    });
  });
}
