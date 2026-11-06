/** 画面の文言。正本は docs/design/ui/08_copy.md（CP-ID をそのまま写す。言い換えない） */
export const CP = {
  nav: { threads: "スレッド", models: "モデル", presets: "プリセット", evals: "評価", settings: "設定" }, // CP-001〜005
  cancel: "キャンセル", // CP-006
  delete: "削除", // CP-007
  save: "保存", // CP-008
  retry: "再試行", // CP-009
  close: "閉じる", // CP-011
  bandLoading: (preset: string) => `モデル読み込み中：${preset}`, // CP-012
  bandApproval: (n: number) => `承認待ち ${n} 件`, // CP-013
  bandEval: (done: number, total: number) => `評価中 ${done}/${total}`, // CP-014
  bandLoadFailed: "モデル読み込み失敗。下の出力で原因を確認", // CP-016
  bandEngineStopped: "推論エンジン停止。再読み込みで復帰", // CP-017
  reload: "再読み込み", // CP-018
  saved: "保存済み", // CP-019
  instruction: "指示", // CP-020
  instructionPlaceholder: "手元のモデルに指示", // CP-021
  send: "送信", // CP-022
  stop: "停止", // CP-023
  contextLabel: "Context", // CP-026
  toolLabel: "ツール", // CP-027
  newThread: "新規", // CP-028
  noThreads: "スレッドなし。入力欄から開始", // CP-030
  renameThread: "名前を変更", // CP-032
  confirmDeleteThread: (title: string) => `「${title}」を削除。会話は戻せない。作業フォルダのファイルは残る`, // CP-033
  thinking: "思考", // CP-034
  truncated: "生成の上限に到達。続きは次の指示で", // CP-207
  looped: "思考の繰り返しを検知して停止。指示を送り直して再試行", // CP-284
  pickFolderTitle: "フォルダのパス", // CP-200
  pickFileTitle: "ファイルのパス", // CP-201
  pathHint: "WSL のパスを貼り付け", // CP-202
  decide: "決定", // CP-203
  tokenTitle: "接続トークン", // CP-204
  tokenHint: "起動時にターミナルに出た URL を開く、またはトークンを貼り付け", // CP-205
  firstModel: "最初のモデル", // CP-069
  useLocalFile: "手元のファイルを使う", // CP-075
} as const;

/**
 * 08_copy.md に無く、画面に必要になった文言。設計書へ戻して決めてもらう（仮置き）。
 * 見つけやすいようここに集める。
 */
export const MISSING_COPY = {
  clearSearch: "消去", // CMP-003 の消去ボタン
  rowMenu: "メニュー", // CMP-004 の … ボタン
  copyCode: "コピー", // CMP-022 のコピーボタン
  copiedCode: "コピー済み", // 同、押した後
  presetSelect: "プリセット", // CMP-015 のラベル（読み上げ）
  engineReady: "準備完了", // 05 のワイヤーにだけ出てくる
  engineStarting: "読み込み中", // 04 CMP-012 の説明にだけ出てくる
  engineStopped: "停止中", // 仮
  engineFailed: "失敗", // 仮（CP-100 の DL 状態と同じ語）
  toastRegion: "通知", // CMP-021 の読み上げ名
  conversation: "会話", // 仮
  navigation: "ページ", // 仮（アイコン列の nav の名前）
} as const;
