/** PG-010 の文言。正本は docs/design/ui/08_copy.md（CP-ID をそのまま写す。言い換えない） */
export const PG10 = {
  draftingLyrics: "歌詞を下書きしています…", // CP-342
  composingPre: "作詞と構成を考えています…", // CP-328
  composingPost: "曲を生成しています…", // CP-329
  loading: "曲を読み込んでいます", // CP-330
  loadFailed: "曲を再生できません", // CP-331
  duration: "長さ（秒）", // CP-332
  instrumental: "歌なし", // CP-333
  lyrics: "歌詞", // CP-334
  lyricsPlaceholder: "空欄ならおまかせで作詞します", // CP-335
  promptPlaceholder: "どんな曲にするか書いてください", // CP-336
  newTrack: "新しい曲", // CP-339
  prompt: "曲の説明", // CP-340
  draft: "AI に下書き", // CP-341
  generate: "生成する", // CP-343
  stop: "止める", // CP-344
  empty: "まだ曲がありません", // CP-345
  noModel: "音楽モデルがありません。ACE-Step 1.5 XL を入手してください", // CP-346
  remake: "作り直す", // CP-348
  deleteTitle: "この曲を削除しますか？", // CP-349
  deleteBody: "MP3 も消えます。元に戻せません。", // CP-350
  overwriteTitle: "今の内容を書き換えますか？", // CP-351
  overwrite: "書き換える", // CP-352
  trackFailed: "曲の生成に失敗しました。GPU を使う他のアプリを閉じてから試してください", // CP-353
  draftFailed: "歌詞の下書きに失敗しました", // CP-354
  insertTag: (tag: string) => `${tag} を入れる`, // CP-355
  busy: "別の生成が動いています", // CP-357
} as const;

/** 08_copy.md に無く、PG-010 に必要になった文言（仮置き）。単位は PG-001 の曲のメッセージと同じ書き方 */
export const PG10_MISSING = {
  seconds: (n: number) => `${n} 秒`,
  bpm: (n: number) => `${n} BPM`,
  tags: "構成タグ", // CMP-023 のタグ列の読み上げ名
} as const;
