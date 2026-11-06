/**
 * 目安メモリ（VRAM・RAM に載るかの見積もり）。粗い計算であって保証ではない。
 * - Q4_K_M の重みは 1 パラメータ約 0.61 byte
 * - 文脈（KV キャッシュ）と作業用の領域に 1.1 倍
 * - 固定で 1GB を足す
 * 基準は D-43（RAM 16GB・VRAM 8GB）と D-59（Qwen3.5 9B Q4_K_M が VRAM 8GB に収まる）。
 * 13B 以上の Q4 は 8GB に入らないと出るように係数を決めた。
 */
export const Q4_BYTES_PER_PARAM = 0.61;
export const RUNTIME_FACTOR = 1.1;
export const RUNTIME_FIXED_GB = 1;

const BYTES_PER_GB = 1e9;
const round1 = (value: number) => Math.round(value * 10) / 10;

/** パラメータ数から Q4_K_M で動かすときの目安（GB） */
export function estimateQ4Gb(params: number): number {
  return round1((params * Q4_BYTES_PER_PARAM * RUNTIME_FACTOR) / BYTES_PER_GB + RUNTIME_FIXED_GB);
}

/** 実ファイルのサイズから動かすときの目安（GB）。ファイル一覧はこちらを使う */
export function fileNeedGb(sizeBytes: number): number {
  return round1((sizeBytes * RUNTIME_FACTOR) / BYTES_PER_GB + RUNTIME_FIXED_GB);
}

/** 絞り込みの上限（GB）。null は指定なし */
export interface MemoryLimit {
  vram: number | null;
  ram: number | null;
}

/**
 * 目安が上限に収まるか。指定した上限はすべて満たす必要がある。
 * 指定があるのに目安が分からない（パラメータ数なし）ものは外す
 */
export function fits(needGb: number | null, { vram, ram }: MemoryLimit): boolean {
  if (vram === null && ram === null) return true;
  if (needGb === null) return false;
  return (vram === null || needGb <= vram) && (ram === null || needGb <= ram);
}
