/** PG-005 の文言。正本は docs/design/ui/08_copy.md（CP-ID をそのまま写す。言い換えない） */
export const PG5 = {
  newSet: "新規", // CP-120
  run: "実行", // CP-121
  import: "取込", // CP-122
  export: "書出", // CP-123
  addCase: "ケースを追加", // CP-124
  columns: { name: "名前", kind: "種類", grader: "採点", tags: "タグ" }, // CP-125
  labels: { input: "入力", kind: "種類", fixture: "ひな形フォルダ", grader: "採点方法", tags: "タグ" }, // CP-126
  kinds: { chat: "対話", agent: "エージェント" }, // CP-127
  graders: { contains: "文字列一致", regex: "正規表現", manual: "人手", test: "テスト" }, // CP-128
  emptyCases: "ケースなし。追加か JSONL の取込で開始", // CP-129
  emptySets: "評価セットなし。新規で作成", // CP-130
  importFailed: (n: number) => `${n} 行を取込失敗。行番号と理由は下の一覧`, // CP-131
  duplicateTitle: "同名のケースあり", // CP-132 の前半
  overwrite: "上書き", // CP-132
  skip: "飛ばす", // CP-132
  recentRuns: "最近のラン", // CP-133
  compare: "比較", // CP-134
  emptyRuns: "ランなし。実行で最初の結果を作成", // CP-135
  runTitle: "実行するプリセット", // CP-136
  tagFilter: "タグで絞る", // CP-137
  runCount: (n: number) => `${n} 件を実行`, // CP-138
  confirmDelete: (name: string) => `「${name}」を削除。ケースも消える`, // CP-139
} as const;

/** 08_copy.md に無く、PG-005 に必要になった文言（仮置き。設計書へ戻して決める） */
export const PG5_MISSING = {
  setName: "名前", // セットの名前欄（CP-125 の列と同じ語）
  description: "説明", // FR-015 のセットの項目
  fixturesDir: "ひな形の置き場", // FR-015 の fixturesDir
  pickFolder: "選択", // fixturesDir の選択ボタン
  expected: "期待する文字列", // match の expected
  matchMode: "一致の条件", // match の mode（含む / 完全一致）
  modeContains: "含む",
  modeExact: "完全一致",
  ignoreCase: "大文字小文字を区別しない", // match の ignoreCase
  scale: "採点の尺度", // manual の scale
  scalePassFail: "○×",
  scaleOneToFive: "1〜5",
  rubric: "採点の目安", // manual の rubric（任意）
  command: "コマンド", // test の command
  tagsHint: "カンマで区切る",
  nameTaken: "同じ名前のケースあり", // FR-015：セット内で重複不可
  moveUp: "上へ",
  moveDown: "下へ",
  editCase: "ケースの編集",
  newCase: "ケースの追加",
  importDone: (added: number, skipped: number) => `${added} 件を追加（飛ばした ${skipped} 件）`,
  runDate: "日時", // 最近のランの列
  runPreset: "プリセット", // 同
  runPassRate: "正解率", // CP-140 と同じ語
  runStatus: { queued: "待機中", running: "実行中", completed: "完了", cancelled: "中止", failed: "失敗" } as Record<string, string>,
  noPresets: "プリセットなし", // 実行ダイアログ
  actions: "操作", // 行の上下・削除の列
} as const;
