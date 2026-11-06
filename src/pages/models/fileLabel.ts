/** 名前を区切る文字。この位置で切ると、語の途中で切れない */
const SEPARATOR = /[-_./]/;

/**
 * 同じリポジトリのファイル名から、ファイルごとの「違う部分」を取る。
 * 全部に共通する前の部分と後ろの部分（拡張子を除く）を外し、区切りの位置で切る。
 * 例: moss-te-heretic-dhq-IQ-4.2G.gguf / moss-te-only-dhq-IQ-2.9G.gguf
 *   → heretic-dhq-IQ-4.2G / only-dhq-IQ-2.9G
 * 違いが取れないとき（1 件だけ、同じ名前など）は、拡張子を除いた名前を返す。
 */
export function distinctLabels(names: string[]): string[] {
  const bases = names.map((name) => name.replace(/\.[^./]+$/, ""));
  if (bases.length < 2) return bases;

  const first = bases[0];
  const shortest = Math.min(...bases.map((base) => base.length));

  let prefix = 0;
  while (prefix < shortest && bases.every((base) => base[prefix] === first[prefix])) prefix += 1;
  while (prefix > 0 && !SEPARATOR.test(first[prefix - 1])) prefix -= 1;

  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    bases.every((base) => base[base.length - 1 - suffix] === first[first.length - 1 - suffix])
  ) {
    suffix += 1;
  }
  // 後ろの共通部分は区切り文字から始まるように切る（違う部分の末尾に区切りを残さない）
  while (suffix > 0 && !SEPARATOR.test(first[first.length - suffix])) suffix -= 1;

  return bases.map((base) => {
    const label = base.slice(prefix, base.length - suffix);
    return label === "" ? base : label;
  });
}
