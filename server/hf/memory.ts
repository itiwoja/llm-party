/**
 * 目安メモリ（VRAM・RAM に載るかの見積もり）。粗い計算であって保証ではない。
 * - Q4_K_M の重みは 1 パラメータ約 0.61 byte
 * - 重みと文脈（KV キャッシュ）で 1.1 倍。GPU に載せる割合で VRAM と RAM に分ける
 * - GPU を使うなら VRAM に固定で 1GB（作業用の領域）。使わないなら同じ分を RAM に足す
 * - RAM には OS とアプリの分を固定で足す
 * 基準は D-43（RAM 16GB・VRAM 8GB）と D-59（Qwen3.5 9B Q4_K_M が VRAM 8GB に収まる）。
 * 13B 以上の Q4 は 8GB に入らないと出るように係数を決めた。
 *
 * node の機能を使わない。画面（src）もバーを動かすたびにここで計算する。
 */
export const Q4_BYTES_PER_PARAM = 0.61;
export const RUNTIME_FACTOR = 1.1;
export const RUNTIME_FIXED_GB = 1;
export const RAM_BASE_GB = 4;
/** 割合（%）を指定しないときの値。全部 GPU に載せる */
export const DEFAULT_GPU_RATIO = 100;

const BYTES_PER_GB = 1e9;
const round1 = (value: number) => Math.round(value * 10) / 10;

export interface MemoryNeed {
  vramGb: number;
  ramGb: number;
}

/** パラメータ数から Q4_K_M の重みのサイズ（byte） */
export const q4Bytes = (params: number) => params * Q4_BYTES_PER_PARAM;

/** 重みのサイズと GPU に載せる割合（0〜100）から、VRAM と RAM の目安（GB） */
export function memoryNeed(sizeBytes: number, gpuRatio: number = DEFAULT_GPU_RATIO): MemoryNeed {
  const totalGb = (sizeBytes * RUNTIME_FACTOR) / BYTES_PER_GB;
  const onGpu = gpuRatio > 0;
  return {
    vramGb: onGpu ? round1((totalGb * gpuRatio) / 100 + RUNTIME_FIXED_GB) : 0,
    ramGb: round1((totalGb * (100 - gpuRatio)) / 100 + RAM_BASE_GB + (onGpu ? 0 : RUNTIME_FIXED_GB)),
  };
}

/** 絞り込みの上限（GB）。null は指定なし */
export interface MemoryLimit {
  vram: number | null;
  ram: number | null;
}

/**
 * 目安が上限に収まるか。VRAM は VRAM の目安と、RAM は RAM の目安と比べ、指定した上限はすべて満たす必要がある。
 * 指定があるのに目安が分からない（パラメータ数なし）ものは外す
 */
export function fits(need: MemoryNeed | null, { vram, ram }: MemoryLimit): boolean {
  if (vram === null && ram === null) return true;
  if (need === null) return false;
  return (vram === null || need.vramGb <= vram) && (ram === null || need.ramGb <= ram);
}
