import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { eventsHandler } from "../events";
import { ApiError } from "../http-error";
import { parse } from "./parse";

export function engineRoutes({ store, engine, bus }: Context): Router {
  const api = Router();

  api.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  api.get("/events", eventsHandler(bus));

  // エンジン（API-023〜025）
  const engineStatus = () => ({ state: engine.state, presetId: engine.presetId, error: engine.error, warning: engine.warning });
  api.get("/engine", (_req, res) => {
    res.json(engineStatus());
  });
  api.post("/engine/load", (req, res) => {
    const { presetId } = parse(z.object({ presetId: z.string().min(1) }), req.body);
    const preset = store.presets.get(presetId);
    if (!preset) throw new ApiError("NOT_FOUND", "プリセットがありません");
    const model = store.models.get(preset.modelId)!;
    if (model.use === "image") throw new ApiError("VALIDATION_ERROR", "画像モデルはチャットでは読み込めません", [{ field: "presetId" }]);
    engine
      .load({
        presetId,
        modelPath: model.path,
        contextSize: preset.contextSize,
        adapterPaths: store.presets.adapters(presetId).map((adapter) => adapter.path),
      })
      .catch(() => undefined); // 失敗は engine イベントで届く
    res.status(202).json(engineStatus());
  });
  api.post("/engine/unload", async (_req, res) => {
    await engine.stop();
    res.json(engineStatus());
  });

  return api;
}
