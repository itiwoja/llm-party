/**
 * HF のファイル一覧の「モデルだけを表示」で、モデル本体ではない GGUF を見分ける。
 * - mmproj（画像の入力部）・imatrix（量子化の計算用）・mtp（先読みの補助部分）は名前の頭に付く
 * - dflash（先読みの下書きモデル）は `dflash2-qwen38-27b-Q8_0.gguf` のように頭か、区切りの後ろに付く
 * どれも単体ではチャットに使えないので出さない
 */
const AUX_PREFIX = /^(mmproj|imatrix|mtp)[-_.]/i;
const DRAFT_TOKEN = /(^|[-_.])dflash/i;

export function isAuxFile(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  return AUX_PREFIX.test(base) || DRAFT_TOKEN.test(base);
}

/** チャット用に出すのはモデル本体の GGUF だけ */
export function isModelFile(name: string): boolean {
  return name.toLowerCase().endsWith(".gguf") && !isAuxFile(name);
}
