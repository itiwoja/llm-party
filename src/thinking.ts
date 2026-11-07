import { CP } from "./copy";
import type { Effort, Model, Preset } from "./types";

export const DEFAULT_EFFORT: Effort = "medium";

const LEVELS: { value: Effort; label: string }[] = [
  { value: "low", label: CP.effortLow },
  { value: "medium", label: CP.effortMedium },
  { value: "high", label: CP.effortHigh },
];
const OFF = { value: "off", label: CP.thinkingOff };
const ON = { value: "on", label: CP.thinkingOn };

type Support = Pick<Model, "supportsThinking" | "supportsEffort">;
type Thinking = Pick<Preset, "thinking" | "effort">;

/** そのモデルで選べるもの（D-76）。空なら思考を変えられないモデル */
export function thinkingOptions(model: Support | undefined): { value: string; label: string }[] {
  if (model?.supportsEffort) return model.supportsThinking ? [OFF, ...LEVELS] : LEVELS;
  return model?.supportsThinking ? [OFF, ON] : [];
}

/** 入力欄のバーに出す段階。オンオフはボタンが持つので、オフの間と段階の無いモデルでは空（D-92） */
export function thinkingLevels(model: Support, preset: Thinking): { value: string; label: string }[] {
  if (!model.supportsEffort) return [];
  return preset.thinking || !model.supportsThinking ? LEVELS : [];
}

/** 段階だけのモデルは thinking が false でも段階を見せる（サーバーも ON で送る。server/thinking.ts） */
export function thinkingChoice(model: Support, preset: Thinking): string {
  if (model.supportsEffort && (preset.thinking || !model.supportsThinking)) return preset.effort;
  return preset.thinking ? "on" : "off";
}

/** 選択肢の値を、プリセットの項目に直す */
export function thinkingPatch(choice: string): { thinking: boolean; effort?: Effort } {
  if (choice === "off") return { thinking: false };
  if (choice === "on") return { thinking: true };
  return { thinking: true, effort: choice as Effort };
}
