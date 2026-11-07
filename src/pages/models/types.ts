/** GET /api/models の形（server/routes/models.ts） */
export interface ModelItem {
  id: string;
  name: string;
  path: string;
  /** チャット（llama-server）か画像生成（sd-server）か音楽生成（acestep.cpp）か */
  use: "chat" | "image" | "music";
  source: "local_ref" | "local_copy" | "hf";
  architecture: string;
  quantization: string | null;
  sizeBytes: number;
  trainContext: number | null;
  missing: boolean;
  supportsThinking: boolean;
  supportsEffort: boolean;
}

export interface AdapterItem {
  id: string;
  name: string;
  path: string;
  source: "local_ref" | "local_copy" | "hf";
  architecture: string;
  baseModelId: string;
  missing: boolean;
}

export interface HfRepo { repo: string; use: "chat" | "image"; downloads: number; updatedAt: string | null; createdAt: string | null; gated: boolean; pipelineTag: string | null; license: string | null; params: number | null; supportsThinking: boolean; supportsEffort: boolean }
export interface HfFile { name: string; quantization: string | null; sizeBytes: number; split: boolean; complete: boolean; parts: { name: string; sizeBytes: number }[] }

export type DownloadStatus = "queued" | "downloading" | "retrying" | "verifying" | "completed" | "failed" | "cancelled";

export interface DownloadItem {
  id: string;
  /** file は保存だけ。チャットのモデルには登録されない */
  kind: "model" | "adapter" | "file";
  repo: string;
  files: { name: string; sizeBytes: number }[];
  status: DownloadStatus;
  receivedBytes: number;
  totalBytes: number | null;
  error: string | null;
  resultId: string | null;
  /** 完了した LoRA の保存先 */
  filePath?: string;
  /** 完了した保存だけの DL の置き場 */
  savedDir?: string;
  /** 保存だけの DL のファイルが全部、登録済みのモデルの本体か部品になっている */
  usedByModel?: boolean;
}

export const isActive = (status: DownloadStatus) => status !== "completed" && status !== "failed" && status !== "cancelled";
