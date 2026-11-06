import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { checkWorkspace } from "../agent/paths";
import type { Context } from "../context";
import { ApiError } from "../http-error";
import { parse } from "./parse";

/** 承認・続行・変更記録・ワークスペース（API-037〜042） */
export function agentRoutes({ store, chat, dataDir }: Context): Router {
  const api = Router();

  api.post("/turns/:id/continue", (req, res) => {
    const { action } = parse(z.object({ action: z.enum(["continue", "stop"]) }), req.body);
    res.json(chat.continueTurn(req.params.id, action));
  });
  api.post("/tool-calls/:id/decision", (req, res) => {
    const { decision, note } = parse(
      z.object({ decision: z.enum(["approve", "reject", "approve_and_auto"]), note: z.string().optional() }),
      req.body,
    );
    res.json(chat.decide(req.params.id, decision, note));
  });

  // 変更記録・取り消し（API-039, 040）
  api.get("/threads/:id/changes", (req, res) => {
    res.json(chat.changes(req.params.id));
  });
  api.post("/file-changes/:id/revert", (req, res) => {
    const { force } = parse(z.object({ force: z.boolean().optional() }), req.body ?? {});
    res.json(chat.revertChange(req.params.id, force ?? false));
  });

  api.get("/workspaces", (_req, res) => {
    res.json({ items: store.agent.workspaces() });
  });
  api.post("/workspaces", (req, res) => {
    const input = parse(z.object({ path: z.string().min(1) }), req.body);
    const real = checkWorkspace(input.path, { dataDir });
    // CP-059
    if (!real) throw new ApiError("PATH_NOT_ALLOWED", "このフォルダは作業フォルダに不可。別のフォルダを選択");
    res.status(201).json(store.agent.registerWorkspace(real, path.basename(real)));
  });

  return api;
}
