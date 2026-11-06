import { closeSync, openSync, readSync, statSync } from "node:fs";
import { ApiError } from "./http-error";

export interface SafetensorsInfo {
  sizeBytes: number;
  /** ヘッダーの __metadata__ にある名前。なければ null */
  name: string | null;
}

/** ヘッダーの長さの上限。実際の画像モデルは数十 KB なので、壊れたファイルで大きく読まないための上限 */
const MAX_HEADER_BYTES = 100 * 1024 * 1024;

/**
 * safetensors の先頭（8 バイトの長さ＋JSON のヘッダー）だけを読む。重みは読まない。
 * 形式として壊れていれば INVALID_SAFETENSORS
 */
export function readSafetensors(file: string): SafetensorsInfo {
  const sizeBytes = statSync(file).size;
  const fail = () => new ApiError("INVALID_SAFETENSORS", "safetensors ファイルではありません");
  if (sizeBytes < 8) throw fail();
  const fd = openSync(file, "r");
  try {
    const length = Buffer.alloc(8);
    readSync(fd, length, 0, 8, 0);
    const headerLength = Number(length.readBigUInt64LE());
    if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || 8 + headerLength > sizeBytes) throw fail();
    const raw = Buffer.alloc(headerLength);
    readSync(fd, raw, 0, headerLength, 8);
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw fail();
    }
    if (typeof header !== "object" || header === null || Array.isArray(header)) throw fail();
    const metadata = header.__metadata__;
    const title = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)["modelspec.title"] : undefined;
    return { sizeBytes, name: typeof title === "string" && title.trim() ? title.trim() : null };
  } finally {
    closeSync(fd);
  }
}
