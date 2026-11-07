/** PG-004 の文言。正本は docs/design/ui/08_copy.md（CP-ID をそのまま写す。言い換えない） */
export const PG4 = {
  newPreset: "新規", // CP-105
  duplicate: "複製", // CP-106
  name: "名前", // CP-107
  model: "モデル", // CP-108
  adaptersLegend: "LoRA と倍率", // CP-109
  // CP-110 の6語。パラメーター名なのでそのまま
  temperature: "temperature",
  topP: "top_p",
  topK: "top_k",
  minP: "min_p",
  presencePenalty: "presence_penalty",
  repeatPenalty: "repeat_penalty",
  systemPrompt: "システムプロンプト", // CP-111
  thinking: "思考モード", // CP-112
  contextSize: "文脈長", // CP-113
  gpuAuto: "GPU に載せる割合を自動で決める", // CP-324
  fillQwen: "Qwen 推奨値を入れる", // CP-114
  nameTaken: "同じ名前のプリセットあり。別の名前が必要", // CP-115
  contextRange: (min: number, max: number) => `文脈長の範囲外。${min}〜${max} で指定`, // CP-116
  adapterMismatch: "ベースモデルが違う LoRA。別の LoRA を選択", // CP-117
  empty: "プリセットなし。新規で作成", // CP-118
  confirmDelete: (name: string) => `「${name}」を削除。過去のランの結果は残る`, // CP-119
  adapter: "LoRA", // CP-109 の前半（行ごとの読み上げ名。CP-081 と同じ語）
  scale: "倍率", // CP-109 の後半（同上）
} as const;

/** 08_copy.md に無く、PG-004 に必要になった文言。設計書へ戻して決めてもらう（仮置き） */
export const PG4_MISSING = {
  addAdapter: "追加", // 05 のワイヤーにだけ出てくる「LoRA と倍率 [追加]」
  qwenGeneral: "Qwen3.5 一般", // FR-014「思考 ON・一般」の名前
} as const;
