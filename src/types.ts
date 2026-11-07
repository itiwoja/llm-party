export interface Thread { id: string; title: string; lastPresetId: string | null }
export interface Message { id: string; role: string; content: string; reasoning: string | null }
export type Effort = "low" | "medium" | "high";
export interface Preset { id: string; name: string; modelId: string; contextSize: number; gpuRatio: number | null; thinking: boolean; effort: Effort }
export interface Model {
  id: string;
  name: string;
  /** 画像モデルは "image"（チャットのモデルは別の値） */
  use?: string;
  /** チャットテンプレートが思考の ON/OFF・段階を受け取るか（D-76） */
  supportsThinking: boolean;
  supportsEffort: boolean;
}
export type EngineState = "stopped" | "starting" | "ready" | "failed" | "installing";
export interface EngineStatus { state: EngineState; presetId: string | null; error: string | null; installPercent?: number | null; /** 設定の警告（文言は worker が作る）。直すまで出続ける */ warning?: string | null }
