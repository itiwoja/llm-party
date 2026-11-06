import { Router } from "express";
import type { Context } from "../context";
import { agentRoutes } from "./agent";
import { engineRoutes } from "./engine";
import { evalRoutes } from "./eval";
import { hfRoutes } from "./hf";
import { modelRoutes } from "./models";
import { presetRoutes } from "./presets";
import { settingRoutes } from "./settings";
import { threadRoutes } from "./threads";

export function apiRoutes(context: Context): Router {
  const api = Router();
  api.use(engineRoutes(context));
  api.use(modelRoutes(context));
  api.use(presetRoutes(context));
  api.use(threadRoutes(context));
  api.use(agentRoutes(context));
  api.use(hfRoutes(context));
  api.use(evalRoutes(context));
  api.use(settingRoutes(context));
  return api;
}
