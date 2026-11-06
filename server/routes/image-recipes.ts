import { existsSync, statSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { HfClient } from "../hf/client";
import { insideDir } from "../hf/names";
import { RECIPES } from "../hf/recipes";
import { parse } from "./parse";

/** 画像モデルのレシピ（API-097・098, D-73）。部品を一括で取り、1 つの画像モデルとして登録する */
export function imageRecipeRoutes({ downloads, store, hfBaseUrl, dataDir }: Context): Router {
  const api = Router();
  const hf = new HfClient(hfBaseUrl, dataDir);

  api.post("/image-recipes", async (req, res) => {
    const { recipe } = parse(z.object({ recipe: z.enum(["moss-image"]) }), req.body);
    const { destDir, files, ...rest } = await downloads.createRecipe(recipe);
    res.status(202).json({ download: { ...rest, files: files.map((file) => ({ name: file.name, sizeBytes: file.size })) } });
  });

  api.get("/image-recipes", async (_req, res) => {
    const root = store.downloads.modelsDir(dataDir);
    const items = [];
    for (const recipe of RECIPES) {
      const sizes = new Map<string, Map<string, number>>();
      for (const repo of new Set(recipe.parts.map((part) => part.repo))) {
        // オフラインでも一覧は出す。サイズは取れなければ入っているファイルの実サイズ
        const tree = await hf.listFiles(repo).catch(() => []);
        sizes.set(repo, new Map(tree.map((file) => [file.path, file.size])));
      }
      const parts = recipe.parts.map((part) => {
        const file = insideDir(root, part.repo, part.file);
        const installed = existsSync(file);
        return {
          key: part.key, repo: part.repo, file: part.file,
          sizeBytes: sizes.get(part.repo)?.get(part.file) ?? (installed ? statSync(file).size : 0),
          installed,
        };
      });
      items.push({
        id: recipe.id, name: recipe.name, parts,
        sizeBytes: parts.reduce((sum, part) => sum + part.sizeBytes, 0),
        installed: parts.every((part) => part.installed),
      });
    }
    res.json({ items });
  });

  return api;
}
