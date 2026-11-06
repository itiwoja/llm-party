/** PG-001 の文言。正本は docs/design/ui/08_copy.md（CP-ID をそのまま写す。言い換えない） */
export const PG1 = {
  pickFolder: "フォルダを選択", // CP-024
  workspace: (name: string) => `作業フォルダ：${name}`, // CP-025
  summarized: (n: number) => `要約済み（${n} 件）`, // CP-035
  status: {
    pending_approval: "承認待ち", // CP-036
    running: "実行中", // CP-037
    succeeded: "成功", // CP-038
    failed: "失敗", // CP-039
    rejected: "却下済み", // CP-040
    denied: "拒否（作業フォルダの外）", // CP-041
    timed_out: "時間切れ（120 秒）", // CP-042
  } as Record<string, string>,
  approve: "承認", // CP-043
  reject: "却下", // CP-044
  approveAuto: "以後自動で承認", // CP-045
  rejectNote: "却下の理由（任意）", // CP-046
  stepLimit: "ツール呼び出し 40 回に到達。続行で次の 40 回", // CP-047
  continue: "続ける", // CP-048
  stop: "やめる", // CP-049
  contextFull: "文脈が満杯。新しいスレッドで続行", // CP-050
  continueInNew: "新しいスレッドで続ける", // CP-051
  tabDiff: "差分", // CP-053
  tabTerminal: "端末", // CP-054
  revert: "元に戻す", // CP-055
  revertConflict: "変更後に編集あり。戻すと編集も消える", // CP-056
  noChanges: "変更なし", // CP-057
  noCommands: "コマンド実行なし", // CP-058
  pathNotAllowed: "このフォルダは作業フォルダに不可。別のフォルダを選択", // CP-059
  close: "閉じる", // CP-011
  cancel: "キャンセル", // CP-006
  bandApproval: (n: number) => `承認待ち ${n} 件`, // CP-013
  bandEval: (done: number, total: number) => `評価中 ${done}/${total}`, // CP-014
} as const;

/** 08_copy.md に無く、画面に必要になった文言（仮置き。設計書へ戻して決める） */
export const MISSING = {
  openPanel: "右パネルを開く", // 閉じたパネルを開くボタン
  panel: "差分と端末", // 右パネルの読み上げ名
  merged: "まとめた差分", // FR-011 の切り替え
  perStep: "1回ずつ", // FR-011 の切り替え
  diffMode: "差分の表示", // 切り替えの読み上げ名
  fileList: "変更したファイル", // ファイル一覧の読み上げ名
  exitCode: "終了コード", // 端末の終了コード
  approvalRegion: "承認", // 承認カードの読み上げ名
  toolOutput: "出力", // ツールカードの本文の見出し
  threadKindChat: "チャット", // 一覧の種類アイコンの読み上げ
  threadKindAgent: "エージェント", // 同
  truncatedOutput: "古い出力は省略", // 端末の保持上限を超えたとき
  reverted: "戻し済み", // 取り消し済みの印
} as const;
