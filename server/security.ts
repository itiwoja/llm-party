import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiError, sendError } from "./http-error";

/** 他のサイトからの呼び出しを断る（R-16）。Host でリバインディング、Origin で別オリジンを防ぐ */
export function hostOriginGuard(port: number): RequestHandler {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!hosts.has(req.headers.host ?? "") || (origin !== undefined && !origins.has(origin))) {
      res.status(403).json({ error: { code: "UNAUTHORIZED", message: "この接続元は使えません" } });
      return;
    }
    next();
  };
}

function matches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerAuth(token: string): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || !matches(header.slice("Bearer ".length), token)) {
      sendError(res, new ApiError("UNAUTHORIZED", "接続トークンが正しくありません"));
      return;
    }
    next();
  };
}
