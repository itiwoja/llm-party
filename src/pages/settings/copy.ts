/** PG-008 の文言。正本は docs/design/ui/08_copy.md（CP-ID をそのまま写す。言い換えない） */
export const PG8 = {
  groupRun: "モデルと実行", // CP-160
  modelsDir: "モデルの置き場", // CP-161
  modelsDirNote: "変更後の DL とコピーだけ新しい場所へ。今のファイルはそのまま", // CP-162
  backend: "実行バックエンド", // CP-163
  backendValue: { auto: "自動", cuda: "CUDA", vulkan: "Vulkan", cpu: "CPU" } as Record<string, string>, // CP-164
  defaultContext: "新しいプリセットの文脈長", // CP-168
  groupConnect: "接続と更新", // CP-169
  hfToken: "HF トークン", // CP-170
  hfTokenNote: "ゲート付きリポジトリの DL にだけ使用。平文で保存", // CP-283
  groupDisplay: "表示と安全", // CP-176
  theme: "テーマ", // CP-177
  themeValue: { system: "システムに合わせる", light: "ライト", dark: "ダーク" }, // CP-178
  autoApprove: "新しいスレッドの自動承認", // CP-179
  groupDiag: "診断と情報", // CP-180
  exportDiag: "診断情報を書き出す", // CP-181
  exportNote: "ログと設定を zip に保存。アプリからの送信なし", // CP-182
  about: (version: string, build: string | null) => (build ? `LLM-PARTY v${version} / llama.cpp ${build}` : `LLM-PARTY v${version}`), // CP-183（build が null のときは llama.cpp の部分を省く）
  copyPath: "パスをコピー", // CP-206
  change: "変更", // CP-072
  free: (size: string) => `空き ${size}`, // CP-073
} as const;

