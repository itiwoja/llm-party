export interface Thread { id: string; title: string; lastPresetId: string | null }
export interface Message { id: string; role: string; content: string; reasoning: string | null }
export interface Preset { id: string; name: string; modelId: string; contextSize: number }
export interface Model { id: string; name: string }
export type EngineState = "stopped" | "starting" | "ready" | "failed";
export interface EngineStatus { state: EngineState; presetId: string | null; error: string | null }
