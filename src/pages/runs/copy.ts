/** PG-006, PG-007 の文言。正本は docs/design/ui/08_copy.md（CP-ID をそのまま写す。言い換えない） */
export const PG6 = {
  passRate: "正解率", // CP-140
  avgScore: "平均点", // CP-141
  avgSpeed: "平均 t/s", // CP-142
  totalTime: "合計時間", // CP-143
  columns: { case: "ケース", result: "結果", time: "時間", speed: "t/s" }, // CP-144
  status: {
    pending: "未実行",
    running: "実行中",
    passed: "合格",
    failed: "不合格",
    needs_review: "採点待ち",
    timed_out: "時間切れ（300 秒）",
    error: "エラー",
    skipped: "飛ばし",
  } as Record<string, string>, // CP-145
  reviewOnly: "採点待ちだけ表示", // CP-146
  cancel: "中止", // CP-147
  confirmCancel: "実行中のケースを止め、残りは飛ばす", // CP-148
  openCompare: "比較を開く", // CP-149
  headings: { input: "入力", answer: "応答", tools: "ツール呼び出し", testOutput: "テストの出力" }, // CP-150
  runFailed: "ラン失敗。エンジン再読み込みでも復帰せず。ログで原因を確認", // CP-151
  marks: { pass: "○", fail: "×" }, // CP-159（1〜5 は点数そのもの）
} as const;

/** 08_copy.md に無く、PG-006 に必要になった文言（仮置き。設計書へ戻して決める） */
export const PG6_MISSING = {
  grading: "採点", // 採点ボタン群の読み上げ名
  pickRun: "ラン", // 同じ評価セットのラン切替
  confirmDeleteRun: (name: string) => `「${name}」のランを削除。結果も消える`,
  progress: "評価の進み", // ProgressBar の読み上げ名
  starting: "準備中", // 割合が出る前
  rubric: "採点の目安",
  expected: "期待する文字列",
  reasoning: "思考", // CP-034 と同じ語
  notFound: "ランがありません",
} as const;
