/** PG-003 の文言。正本は docs/design/ui/08_copy.md（CP-ID をそのまま写す。言い換えない） */
export const PG3 = {
  tabModels: "手元のモデル", // CP-080
  tabAdapters: "LoRA", // CP-081
  tabHf: "Hugging Face を探す", // CP-082
  tabDownloads: "DL", // CP-083
  register: "ファイルを登録", // CP-084
  columns: { name: "名前", quantization: "量子化", size: "サイズ", status: "状態" }, // CP-085
  emptyModels: "モデルなし。ファイル登録か Hugging Face から入手", // CP-087
  emptyAdapters: "LoRA なし。GGUF 形式の LoRA を登録", // CP-088
  emptySearch: "検索結果なし。語を変えて再検索", // CP-089
  emptyDownloads: "DL なし", // CP-090
  searchRepo: "リポジトリを検索", // CP-091
  fileMissing: "ファイルが見つからない。選び直すか削除", // CP-092
  notGguf: "GGUF 以外のファイル。.gguf を選択", // CP-093
  gated: "ゲート付きリポジトリ。設定で HF トークンが必要", // CP-096
  confirmDelete: (name: string) => `「${name}」を削除`, // CP-098
  deleteFile: "ファイルも消す", // CP-099
  downloadStatus: {
    queued: "待機中",
    downloading: "DL 中",
    retrying: "再試行中",
    verifying: "確認中",
    completed: "完了",
    failed: "失敗",
    cancelled: "取り消し済み",
  } as Record<string, string>, // CP-100
  resume: "再開", // CP-101
  cancelDownload: "DL を取り消す", // CP-102
  registerMode: "登録の方法", // CP-103
  modeOptions: { reference: "参照", copy: "コピー" }, // CP-103
  baseModel: "ベースモデル", // CP-104
  download: "DL する", // CP-074
  name: "名前", // CP-085（先頭の語）
  cancel: "キャンセル", // CP-006
} as const;

/**
 * 08_copy.md に無く、PG-003 に必要になった文言。設計書へ戻して決めてもらう（仮置き）。
 */
export const PG3_MISSING = {
  colDownloads: "DL 数", // HF 検索結果の列（FR-012「リポジトリ名・DL 数・更新日」の語）
  colUpdated: "更新日", // 同。updatedAt が null のときは空
  colRepo: "リポジトリ", // 同
  colFile: "ファイル", // HF のファイル一覧の列
  kindLabel: "種類", // DL する前に model / adapter を選ぶラジオの名前
  incomplete: "分割ファイルがそろっていない", // complete:false の DL 不可の理由
  linkToSettings: "設定", // CP-096 の後ろに付ける設定への入口（CP-005 の語）
  genre: "ジャンル", // CP-285 検索の絞り込みと、結果の列
  genres: {
    all: "すべて",
    chat: "チャット",
    image: "画像生成",
  }, // CP-286
  uncensored: "無検閲のみ", // CP-287
  colLicense: "ライセンス", // CP-288
  imageHint: "画像生成に使える一体型の .safetensors だけを表示",
  fileCount: (n: number) => `${n} ファイル`, // CP-291
  savedTo: "保存先", // CP-292
  vram: "VRAM まで（GB）", // CP-309
  ram: "RAM まで（GB）", // CP-310
  colFileSize: "容量", // CP-326
  colVram: "VRAM推奨", // CP-311
  colRam: "RAM推奨", // CP-320
  memoryHint: "検索結果の推奨は Q4_K_M で計算。パラメータ数の分からないモデルは外す", // CP-312
  splitHint: "推奨はこの割合で動かすときの目安。RAM は OS とアプリの分（4GB）を含む。文脈が長いと増える", // CP-321
  colStrength: "強さ", // HF 検索結果の列。強さはパラメータ数で測る（HF は性能の点数を返さない）
  modelsOnlyHint: "モデル（GGUF）だけを表示。画像の入力部（mmproj）と量子化の計算用（imatrix）は外す", // 同
  noModelFile: "GGUF のモデルがない。チャットでは動かせない", // 同
  noImageFile: "画像生成に使えるファイルがない", // 同
  recipeNote: "既定の組み合わせは 16GB 以上の GPU を前提", // R-18（画像の一括 DL の注意）
  musicRecipeNote: "音楽生成のモデル一式（XL）。8GB の GPU で動く", // CP-337（D-78, D-79）
  recipeTotal: (size: string) => `合計 ${size}`, // API-098 の sizeBytes
  recipeStart: "一括で DL する", // API-097
  recipeInstalled: "入っています", // API-098 の installed
  recipeQueued: "DL の待ち行列に入れました。進みは DL で見られる", // API-097 の 202
  strengthHint:"強さは パラメータ数 で比べる。バーは今の結果の中で一番大きいモデルを 100% とする。パラメータ数の分からないモデルは末尾", // 同
} as const;
