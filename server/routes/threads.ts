import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { ApiError } from "../http-error";
import { parse } from "./parse";

export function threadRoutes({ store, chat }: Context): Router {
  const api = Router();

  // スレッド・ターン（API-030〜036）
  api.get("/threads", (req, res) => {
    const query = parse(
      z.object({ q: z.string().optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
      req.query,
    );
    res.json(store.threads.list(query));
  });
  api.post("/threads", (req, res) => {
    const { presetId, workspaceId, summaryFromThreadId } = parse(
      z.object({ presetId: z.string().min(1), workspaceId: z.string().min(1).optional(), summaryFromThreadId: z.string().min(1).optional() }),
      req.body,
    );
    if (!store.presets.get(presetId)) throw new ApiError("NOT_FOUND", "プリセットがありません");
    const project = workspaceId ? store.agent.workspace(workspaceId) : null;
    if (workspaceId && (!project || project.hiddenAt)) throw new ApiError("NOT_FOUND", "ワークスペースがありません");
    // FR-006「新しいスレッドで続ける」。設計の API-031 にない追加の引数（要約を最初のメッセージにする）
    if (summaryFromThreadId) {
      if (!store.threads.get(summaryFromThreadId)) throw new ApiError("NOT_FOUND", "スレッドがありません");
      const thread = store.threads.createFromSummary(summaryFromThreadId, presetId, workspaceId ?? null);
      if (!thread) throw new ApiError("CONFLICT", "要約がありません");
      res.status(201).json(thread);
      return;
    }
    res.status(201).json(store.threads.create(presetId, workspaceId ?? null));
  });
  api.patch("/threads/:id", (req, res) => {
    const patch = parse(z.object({ title: z.string().trim().min(1).optional(), autoApprove: z.boolean().optional() }), req.body);
    if (!store.threads.get(req.params.id)) throw new ApiError("NOT_FOUND", "スレッドがありません");
    store.threads.update(req.params.id, patch);
    res.json(store.threads.get(req.params.id));
  });
  api.delete("/threads/:id", async (req, res) => {
    await chat.deleteThread(req.params.id);
    res.status(204).end();
  });
  api.get("/threads/:id/messages", (req, res) => {
    if (!store.threads.get(req.params.id)) throw new ApiError("NOT_FOUND", "スレッドがありません");
    const toolCalls = store.agent.toolCallsOfThread(req.params.id).map((call) => {
      const preview = call.status === "pending_approval" ? chat.pendingPreview(call.id) : undefined;
      return preview ? { ...call, preview } : call;
    });
    res.json({ ...store.threads.threadDetail(req.params.id), toolCalls });
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
