import { existsSync, statSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { HfClient } from "../hf/client";
import { insideDir } from "../hf/names";
import { RECIPES, type Recipe, type RecipeKind } from "../hf/recipes";
import { parse } from "./parse";

/** モデルのレシピ（API-097・098, D-73 / API-106・107, D-78）。部品を一括で取り、1 つのモデルとして登録する */
export function recipeRoutes({ downloads, store, hfBaseUrl, dataDir }: Context): Router {
  const api = Router();
  const hf = new HfClient(hfBaseUrl, dataDir);

  const route = (url: string, kind: RecipeKind, ids: [Recipe["id"], ...Recipe["id"][]]) => {
    api.post(url, async (req, res) => {
      const { recipe } = parse(z.object({ recipe: z.enum(ids) }), req.body);
      const { destDir, files, ...rest } = await downloads.createRecipe(recipe);
      res.status(202).json({ download: { ...rest, files: files.map((file) => ({ name: file.name, sizeBytes: file.size })) } });
    });

    api.get(url, async (_req, res) => {
      const root = store.downloads.modelsDir(dataDir);
      const items = [];
      for (const recipe of RECIPES.filter((item) => item.kind === kind)) {
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
          // 部品があっても登録がなければ生成に使えないので、DL できるように installed にしない
        installed: parts.every((part) => part.installed) && store.downloads.isRegistered(recipe.kind, insideDir(root, recipe.parts[0].repo, recipe.parts[0].file)),
        });
      }
      res.json({ items });
    });
  };

  route("/image-recipes", "image-set", ["moss-image"]);
  route("/music-recipes", "music-set", ["ace-step"]);
  return api;
}
