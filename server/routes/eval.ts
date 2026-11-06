import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { exportJsonl, importJsonl } from "../eval/jsonl";
import { caseSchema } from "../eval/schema";
import { ApiError } from "../http-error";
import { parse } from "./parse";

const setSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().nullish(),
  fixturesDir: z.string().trim().nullish(),
});

const saveSchema = setSchema.extend({ cases: z.array(caseSchema.safeExtend({ id: z.string().optional() })) });

const csv = (value: unknown): string[] | null => {
  if (typeof value !== "string") return null;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : null;
};

/** 評価（API-070〜082） */
export function evalRoutes({ store, evals }: Context): Router {
  const api = Router();
  const required = <T>(value: T | null, message: string): T => {
    if (!value) throw new ApiError("NOT_FOUND", message);
    return value;
  };

  // 評価セット（API-070〜076）
  api.get("/eval-sets", (_req, res) => {
    res.json({ items: store.evals.sets() });
  });
  api.post("/eval-sets", (req, res) => {
    res.status(201).json(store.evals.createSet(parse(setSchema, req.body)));
  });
  api.get("/eval-sets/:id", (req, res) => {
    res.json(required(store.evals.setWithCases(req.params.id), "評価セットがありません"));
  });
  api.put("/eval-sets/:id", (req, res) => {
    res.json(store.evals.saveSet(req.params.id, parse(saveSchema, req.body)));
  });
  api.delete("/eval-sets/:id", async (req, res) => {
    await evals.deleteSet(req.params.id);
    res.status(204).end();
  });
  api.post("/eval-sets/:id/import", (req, res) => {
    const { path, onDuplicate } = parse(z.object({ path: z.string().min(1), onDuplicate: z.enum(["overwrite", "skip"]) }), req.body);
    required(store.evals.set(req.params.id), "評価セットがありません");
    res.json(importJsonl(store.evals, req.params.id, path, onDuplicate));
  });
  api.post("/eval-sets/:id/export", (req, res) => {
    const { path } = parse(z.object({ path: z.string().min(1) }), req.body);
    required(store.evals.set(req.params.id), "評価セットがありません");
    res.json(exportJsonl(store.evals, req.params.id, path));
  });

  // ラン（API-077〜081）
  api.post("/eval-runs", (req, res) => {
    const input = parse(z.object({ evalSetId: z.string().min(1), presetIds: z.array(z.string().min(1)).min(1), tags: z.array(z.string()).optional() }), req.body);
    res.status(202).json(evals.createRuns(input));
  });
  api.get("/eval-runs", (req, res) => {
    const evalSetId = typeof req.query.evalSetId === "string" ? req.query.evalSetId : undefined;
    res.json({ items: store.evals.runs(evalSetId) });
  });
  api.get("/eval-runs/:id", (req, res) => {
    const run = required(store.evals.run(req.params.id), "ランがありません");
    res.json({ run: { ...run, ...store.evals.counts(run.id) }, results: store.evals.results(run.id) });
  });
  api.post("/eval-runs/:id/cancel", async (req, res) => {
    res.json(await evals.cancelRun(req.params.id));
  });
  api.delete("/eval-runs/:id", async (req, res) => {
    await evals.deleteRun(req.params.id);
    res.status(204).end();
  });
  api.patch("/eval-results/:id", (req, res) => {
    const input = parse(
      z.union([z.strictObject({ verdict: z.enum(["passed", "failed"]) }), z.strictObject({ score: z.number().int().min(1).max(5) })]),
      req.body,
    );
    const { result, run } = store.evals.grade(req.params.id, input);
    res.json({ result, run: { id: run.id, passRate: run.passRate, avgScore: run.avgScore } });
  });

  // 推移と比較（API-082）
  api.get("/eval-sets/:id/trend", (req, res) => {
    const tags = csv(req.query.tags);
    if (req.query.compare === undefined) return void res.json(evals.trend(req.params.id, tags));
    const ids = csv(req.query.compare);
    if (ids?.length !== 2) throw new ApiError("VALIDATION_ERROR", "比べるランは2つ指定します", [{ field: "compare" }]);
    res.json({ ...evals.trend(req.params.id, tags), ...evals.compare(req.params.id, ids[0], ids[1], tags) });
  });

  return api;
}
