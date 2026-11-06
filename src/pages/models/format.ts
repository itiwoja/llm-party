/** 容量の単位は 10 進の GB（D-64） */
export const BYTES_PER_GB = 1e9;
/** DL・コピーで空きに足す余白（BR-05, D-31。server と同じ 2GB） */
export const FREE_MARGIN_BYTES = 2_000_000_000;

/** 「5.4GB」。1GB 未満は MB、1MB 未満は KB */
export function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)}MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))}KB`;
}

/** 残り時間。「m:ss」か「h:mm:ss」（語は付けない） */
export function formatEta(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** 更新日。null は空 */
export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
