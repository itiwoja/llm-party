import { statSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { eventsHandler } from "../events";
import { readGguf } from "../gguf";
import { ApiError } from "../http-error";

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(
    "VALIDATION_ERROR",
    "入力が正しくありません",
    result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
  );
}

const samplingSchema = z.object({
  temperature: z.number().min(0),
  topP: z.number().min(0).max(1),
  topK: z.number().int().min(0),
  minP: z.number().min(0).max(1),
  presencePenalty: z.number(),
  repeatPenalty: z.number().min(0),
});

const presetSchema = z.object({
  name: z.string().trim().min(1),
  modelId: z.string().min(1),
  sampling: samplingSchema,
  systemPrompt: z.string().nullish(),
  thinking: z.boolean(),
  contextSize: z.number().int().min(2048),
});

export function apiRoutes({ store, engine, chat, bus }: Context): Router {
  const api = Router();

  api.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  api.get("/events", eventsHandler(bus));

  // エンジン（API-023〜025）
  const engineStatus = () => ({ state: engine.state, presetId: engine.presetId, error: engine.error });
  api.get("/engine", (_req, res) => {
    res.json(engineStatus());
  });
  api.post("/engine/load", (req, res) => {
    const { presetId } = parse(z.object({ presetId: z.string().min(1) }), req.body);
    const preset = store.getPreset(presetId);
    if (!preset) throw new ApiError("NOT_FOUND", "プリセットがありません");
    const model = store.getModel(preset.modelId)!;
    engine
      .load({
        presetId,
        modelPath: model.path,
        contextSize: preset.contextSize,
        adapterPaths: store.presetAdapters(presetId).map((adapter) => adapter.path),
      })
      .catch(() => undefined); // 失敗は engine イベントで届く
    res.status(202).json(engineStatus());
  });
  api.post("/engine/unload", async (_req, res) => {
    await engine.stop();
    res.json(engineStatus());
  });

  // モデル（API-050〜051）
  api.get("/models", (_req, res) => {
    res.json({ items: store.listModels() });
  });
  api.post("/models", (req, res) => {
    const input = parse(
      z.object({ path: z.string().min(1), mode: z.enum(["reference", "copy"]), name: z.string().trim().min(1).optional() }),
      req.body,
    );
    if (input.mode === "copy") throw new ApiError("VALIDATION_ERROR", "コピーでの登録はまだ使えません", [{ field: "mode" }]);
    const file = path.resolve(input.path);
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      // 下で扱う
    }
    if (!isFile) throw new ApiError("VALIDATION_ERROR", "ファイルが見つかりません", [{ field: "path" }]);
    const info = readGguf(file);
    if (info.type !== "model") throw new ApiError("INVALID_GGUF", "これはモデルの GGUF ではありません");
    const model = store.createModel({
      name: input.name ?? info.name ?? path.basename(file, ".gguf"),
      path: file,
      source: "local_ref",
      architecture: info.architecture,
      quantization: info.quantization,
      sizeBytes: info.sizeBytes,
      trainContext: info.trainContext,
    });
    res.status(201).json(model);
  });

  // プリセット（API-060〜061）
  api.get("/presets", (_req, res) => {
    res.json({ items: store.listPresets() });
  });
  api.post("/presets", (req, res) => {
    res.status(201).json(store.createPreset(parse(presetSchema, req.body)));
  });

  // スレッド・ターン（API-030〜036）
  api.get("/threads", (req, res) => {
    const query = parse(
      z.object({ q: z.string().optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
      req.query,
    );
    res.json(store.listThreads(query));
  });
  api.post("/threads", (req, res) => {
    const { presetId } = parse(z.object({ presetId: z.string().min(1) }), req.body);
    if (!store.getPreset(presetId)) throw new ApiError("NOT_FOUND", "プリセットがありません");
    res.status(201).json(store.createThread(presetId));
  });
  api.get("/threads/:id/messages", (req, res) => {
    if (!store.getThread(req.params.id)) throw new ApiError("NOT_FOUND", "スレッドがありません");
    res.json(store.threadDetail(req.params.id));
  });
  api.post("/threads/:id/turns", (req, res) => {
    const { presetId, content } = parse(z.object({ presetId: z.string().min(1), content: z.string().trim().min(1) }), req.body);
    res.status(202).json(chat.send(req.params.id, presetId, content));
  });
  api.post("/turns/:id/cancel", (req, res) => {
    chat.cancel(req.params.id);
    res.json({ status: "cancelling" });
  });

  return api;
}
