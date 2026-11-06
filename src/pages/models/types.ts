/** GET /api/models の形（server/routes/models.ts） */
export interface ModelItem {
  id: string;
  name: string;
  path: string;
  source: "local_ref" | "local_copy" | "hf";
  architecture: string;
  quantization: string | null;
  sizeBytes: number;
  trainContext: number | null;
  missing: boolean;
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

export interface HfRepo { repo: string; downloads: number; updatedAt: string | null; createdAt: string | null; gated: boolean }
export interface HfFile { name: string; quantization: string | null; sizeBytes: number; split: boolean; complete: boolean; parts: { name: string; sizeBytes: number }[] }

export type DownloadStatus = "queued" | "downloading" | "retrying" | "verifying" | "completed" | "failed" | "cancelled";

export interface DownloadItem {
  id: string;
  kind: "model" | "adapter";
  repo: string;
  files: { name: string; sizeBytes: number }[];
  status: DownloadStatus;
  receivedBytes: number;
  totalBytes: number | null;
  error: string | null;
  resultId: string | null;
  /** 完了した LoRA の保存先 */
  filePath?: string;
}

export const isActive = (status: DownloadStatus) => status !== "completed" && status !== "failed" && status !== "cancelled";
