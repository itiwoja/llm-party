/** FR-014 の Qwen3.5 公式の推奨値（D-28）。repeat は表に無いので 1.0。コーディングだけ思考のループを抑えるため 1.05（D-69） */
export interface Sampling {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  presencePenalty: number;
  repeatPenalty: number;
}

export interface Recommended { name: string; thinking: boolean; sampling: Sampling }

export const QWEN_CODING: Recommended = {
  name: "Qwen3.5 コーディング", // FR-014
  thinking: true,
  sampling: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1.05 },
};
export const QWEN_CHAT: Recommended = {
  name: "Qwen3.5 対話", // FR-014
  thinking: false,
  sampling: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 },
};
/** 「思考 ON・一般」（1.0 / 0.95 / 20 / 0.0 / 1.5）。名前は 08_copy.md に無い（PG4_MISSING） */
export const QWEN_GENERAL: Recommended = {
  name: "Qwen3.5 一般",
  thinking: true,
  sampling: { temperature: 1, topP: 0.95, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 },
};
