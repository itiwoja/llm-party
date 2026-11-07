import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { ApiError } from "../http-error";
import { CONTEXT_MIN } from "../store/presets";
import { EFFORTS } from "../thinking";
import { parse } from "./parse";

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
  adapters: z.array(z.object({ adapterId: z.string().min(1), scale: z.number().min(0) })).optional(),
  sampling: samplingSchema,
  systemPrompt: z.string().nullish(),
  thinking: z.boolean(),
  effort: z.enum(EFFORTS).optional(),
  contextSize: z.number().int().min(CONTEXT_MIN),
});

export function presetRoutes({ store }: Context): Router {
  const api = Router();

  // プリセット（API-060〜063）
  api.get("/presets", (_req, res) => {
    res.json({ items: store.presets.list() });
  });
  api.post("/presets", (req, res) => {
    res.status(201).json(store.presets.create(parse(presetSchema, req.body)));
  });
  api.patch("/presets/:id", (req, res) => {
    const patch = parse(presetSchema.partial(), req.body);
    res.json(store.presets.update(req.params.id, patch));
  });
  api.delete("/presets/:id", (req, res) => {
    if (!store.presets.get(req.params.id)) throw new ApiError("NOT_FOUND", "プリセットがありません");
    store.presets.delete(req.params.id);
    res.status(204).end();
  });

  return api;
}
