/** PG-007 の文言。正本は docs/design/ui/08_copy.md（CP-ID をそのまま写す。言い換えない） */
export const PG7 = {
  runA: "ラン A", // CP-152
  runB: "ラン B", // CP-152
  improved: (n: number) => `${n} 改善`, // CP-153
  regressed: (n: number) => `${n} 悪化`, // CP-153
  same: (n: number) => `${n} 同じ`, // CP-153
  trend: "推移", // CP-154
  change: { regressed: "悪化", improved: "改善", same: "同じ" }, // CP-155
  tagFilter: "タグで絞る", // CP-156
  empty: "比較にはランが2つ必要。評価セットから実行", // CP-157
  answerA: "ラン A の応答", // CP-158
  answerB: "ラン B の応答", // CP-158
} as const;

/** 08_copy.md に無く、PG-007 に必要になった文言（仮置き。設計書へ戻して決める） */
export const PG7_MISSING = {
  changeColumn: "変化", // ケース表の列
  tableTitle: "正解率の推移", // 折れ線の代わりの表の読み上げ名
  date: "日時", // 同、列
  noCases: "両方に結果があるケースなし", // 絞り込みで 0 件のとき
  caseDetail: "ケースの詳細", // 横並びの読み上げ名
} as const;
