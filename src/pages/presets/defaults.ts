import { api, ApiRequestError } from "../../api";
import { CONTEXT_MIN } from "./limits";
import type { Recommended } from "./qwen";

/** 新しいプリセットの文脈長：設定の既定を、モデルの学習時の文脈長（と下限）に収める */
export function contextFor(defaultContextSize: number, trainContext: number | null): number {
  const capped = trainContext !== null ? Math.min(defaultContextSize, trainContext) : defaultContextSize;
  return Math.max(CONTEXT_MIN, capped);
}

/** 推奨値でプリセットを作る（初回セットアップ。FR-014）。同じ名前が既にあれば作らない */
export async function createRecommended(model: { id: string; trainContext: number | null }, recommended: Recommended, defaultContextSize: number, name = recommended.name): Promise<void> {
  try {
    await api("/presets", {
      name,
      modelId: model.id,
      sampling: recommended.sampling,
      thinking: recommended.thinking,
      contextSize: contextFor(defaultContextSize, model.trainContext),
    });
  } catch (err) {
    if (!(err instanceof ApiRequestError && err.status === 409)) throw err;
  }
}
