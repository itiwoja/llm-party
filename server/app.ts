import express, { type Express, type Router } from "express";
import type { Context } from "./context";
import { ApiError, errorHandler } from "./http-error";
import { apiRoutes } from "./routes";
import { bearerAuth, hostOriginGuard } from "./security";

export interface AppOptions {
  port: number;
  token: string;
  context: Context;
  /** 起動の入口ごとに足す API（localhost 段階の API-093〜094） */
  extraRoutes?: (context: Context) => Router;
}

/** worker の API。Electron に依存させない（07）。画面の配信は起動の入口が足す */
export function createApp({ port, token, context, extraRoutes }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(hostOriginGuard(port));

  const api = express.Router();
  api.use(bearerAuth(token));
  api.use(express.json({ limit: "10mb" }));
  api.use(apiRoutes(context));
  if (extraRoutes) api.use(extraRoutes(context));
  api.use((_req, _res, next) => next(new ApiError("NOT_FOUND", "対象がありません")));
  app.use("/api", api, errorHandler);

  return app;
}
