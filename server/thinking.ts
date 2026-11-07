/** 思考の段階（D-76）。gpt-oss 系のテンプレートの reasoning_effort の値 */
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = "medium";

export interface ThinkingSupport { supportsThinking: boolean; supportsEffort: boolean }

/** 何を変えられるかはチャットテンプレート次第。llama-server は chat_template_kwargs をテンプレートへ渡すだけなので、変数名で見分ける */
export function thinkingSupport(template: string | undefined): ThinkingSupport {
  return {
    supportsThinking: /\benable_thinking\b/.test(template ?? ""),
    supportsEffort: /\breasoning_effort\b/.test(template ?? ""),
  };
}

/** chat_template_kwargs の思考の分。段階だけのモデルは思考を切れないので、常に ON で送る */
export function thinkingKwargs(model: ThinkingSupport, preset: { thinking: boolean; effort: Effort }): { enable_thinking: boolean; reasoning_effort?: Effort } {
  const enabled = preset.thinking || (model.supportsEffort && !model.supportsThinking);
  return { enable_thinking: enabled, ...(model.supportsEffort && enabled ? { reasoning_effort: preset.effort } : {}) };
}
