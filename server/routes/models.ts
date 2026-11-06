import { copyFileSync, constants, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { readGguf } from "../gguf";
import { ApiError } from "../http-error";
import { COPY_MARGIN_BYTES } from "../store/models";
import type { Store } from "../store";
import { parse } from "./parse";

type Location = { path: string; source: string };

/** 置き場へコピーする。空きが足りなければ 507、同名があれば上書きせず 409 */
function copyToDir(store: Store, dir: string, file: string, sizeBytes: number): string {
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file));
  if (existsSync(dest)) throw new ApiError("CONFLICT", "置き場に同じ名前のファイルがあります");
  const need = sizeBytes + COPY_MARGIN_BYTES;
  if (store.models.freeBytes(dir) < need) {
    throw new ApiError("INSUFFICIENT_STORAGE", `空き容量不足。${(need / 1e9).toFixed(1)} GB 必要。置き場の変更で解消`);
  }
  copyFileSync(file, dest, constants.COPYFILE_EXCL);
  return dest;
}

/** 分割 GGUF はパスが先頭の部品を指すので、同じフォルダの残りの部品も返す */
function ownedFiles(file: string): string[] {
  const match = /^(.*)-00001-of-(\d{5})\.gguf$/.exec(path.basename(file));
  if (!match) return [file];
  const dir = path.dirname(file);
  if (!existsSync(dir)) return [file];
  const isPart = (name: string) => name.startsWith(`${match[1]}-`) && /^-\d{5}-of-\d{5}\.gguf$/.test(name.slice(match[1].length)) && name.endsWith(`-of-${match[2]}.gguf`);
  return readdirSync(dir).filter(isPart).map((name) => path.join(dir, name));
}

/** 参照は消さない。コピー・DL したものだけ deleteFile=true で消す */
function removeOwnedFile(item: Location, deleteFile: boolean): void {
  if (!deleteFile || item.source === "local_ref") return;
  for (const file of ownedFiles(item.path)) rmSync(file, { force: true });
}

const withMissing = <T extends { path: string }>(item: T) => ({ ...item, missing: !existsSync(item.path) });

export function modelRoutes({ store, dataDir }: Context): Router {
  const api = Router();
  const deleteQuery = z.object({ deleteFile: z.enum(["true", "false"]).optional() });

  // モデル・LoRA（API-050〜052、API-058〜059）
  // LoRA の一覧は API-050 の応答に adapters として含める（設計表に GET /api/adapters がないため）
  api.get("/models", (_req, res) => {
    res.json({ items: store.models.list().map(withMissing), adapters: store.adapters.list().map(withMissing) });
  });
  api.post("/models", (req, res) => {
    const input = parse(
      z.object({ path: z.string().min(1), mode: z.enum(["reference", "copy"]), name: z.string().trim().min(1).optional() }),
      req.body,
    );
    const file = path.resolve(input.path);
    const info = readFileInfo(file);
    if (info.type !== "model") throw new ApiError("INVALID_GGUF", "これはモデルの GGUF ではありません");
    const copied = input.mode === "copy" ? copyToDir(store, store.models.modelsDir(dataDir), file, info.sizeBytes) : null;
    try {
      const model = store.models.create({
        name: input.name ?? info.name ?? path.basename(file, ".gguf"),
        path: copied ?? file,
        source: copied ? "local_copy" : "local_ref",
        architecture: info.architecture,
        quantization: info.quantization,
        sizeBytes: info.sizeBytes,
        trainContext: info.trainContext,
      });
      res.status(201).json(model);
    } catch (error) {
      if (copied) rmSync(copied, { force: true });
      throw error;
    }
  });
  api.delete("/models/:id", (req, res) => {
    const { deleteFile } = parse(deleteQuery, req.query);
    const model = store.models.get(req.params.id);
    if (!model) throw new ApiError("NOT_FOUND", "モデルがありません");
    const presets = store.models.presetNames(model.id);
    if (presets.length > 0) {
      throw new ApiError("CONFLICT", `プリセット「${presets[0]}」で使用中のため削除不可`, presets.map((name) => ({ name })));
    }
    const adapters = store.models.adapterNames(model.id);
    if (adapters.length > 0) {
      throw new ApiError("CONFLICT", "このモデルを元にした LoRA があるため削除不可", adapters.map((name) => ({ name })));
    }
    store.models.delete(model.id);
    removeOwnedFile(model, deleteFile === "true");
    res.status(204).end();
  });

  api.post("/adapters", (req, res) => {
    const input = parse(
      z.object({
        path: z.string().min(1),
        baseModelId: z.string().min(1),
        mode: z.enum(["reference", "copy"]),
        name: z.string().trim().min(1).optional(),
      }),
      req.body,
    );
    const base = store.models.get(input.baseModelId);
    if (!base) throw new ApiError("NOT_FOUND", "モデルがありません");
    if (base.use === "image") throw new ApiError("VALIDATION_ERROR", "画像モデルには LoRA を付けられません", [{ field: "baseModelId" }]);
    const file = path.resolve(input.path);
    const info = readFileInfo(file);
    if (info.type !== "adapter") {
      throw new ApiError("INVALID_GGUF", "llama.cpp 形式の LoRA ではない。convert_lora_to_gguf.py で変換が必要");
    }
    if (info.architecture !== base.architecture) {
      throw new ApiError("VALIDATION_ERROR", "このモデルでは使えない LoRA。ベースモデルが不一致", [{ field: "baseModelId" }]);
    }
    const copied = input.mode === "copy" ? copyToDir(store, store.models.modelsDir(dataDir), file, info.sizeBytes) : null;
    try {
      const adapter = store.adapters.create({
        baseModelId: base.id,
        name: input.name ?? info.name ?? path.basename(file, ".gguf"),
        path: copied ?? file,
        source: copied ? "local_copy" : "local_ref",
        architecture: info.architecture,
      });
      res.status(201).json(adapter);
    } catch (error) {
      if (copied) rmSync(copied, { force: true });
      throw error;
    }
  });
  api.delete("/adapters/:id", (req, res) => {
    const { deleteFile } = parse(deleteQuery, req.query);
    const adapter = store.adapters.get(req.params.id);
    if (!adapter) throw new ApiError("NOT_FOUND", "LoRA がありません");
    const presets = store.adapters.presetNames(adapter.id);
    if (presets.length > 0) {
      throw new ApiError("CONFLICT", `プリセット「${presets[0]}」で使用中のため削除不可`, presets.map((name) => ({ name })));
    }
    store.adapters.delete(adapter.id);
    removeOwnedFile(adapter, deleteFile === "true");
    res.status(204).end();
  });

  return api;
}

/** 登録するファイルの GGUF を読む。ないファイルは 400 */
function readFileInfo(file: string) {
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    // 下で扱う
  }
  if (!isFile) throw new ApiError("VALIDATION_ERROR", "ファイルが見つかりません", [{ field: "path" }]);
  return readGguf(file);
}
