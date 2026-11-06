/** PG-002 の文言。正本は docs/design/ui/08_copy.md（CP-ID をそのまま写す。言い換えない） */
export const PG2 = {
  heading: "最初のモデル", // CP-069
  recommended: (model: string, size: string) => `おすすめ：${model}（${size}）`, // CP-070
  place: "置き場", // CP-071
  change: "変更", // CP-072
  free: (size: string) => `空き ${size}`, // CP-073
  download: "DL する", // CP-074
  useLocalFile: "手元のファイルを使う", // CP-075
  noSpace: (need: string) => `空き容量不足。${need} 必要。置き場の変更で解消`, // CP-076
  later: "あとで", // CP-065
  next: "次へ", // CP-066
  commHeading: "外への通信", // CP-078
  commBody: "通信先は huggingface.co と github.com の2か所だけ。会話の中身は端末の外に出ない", // CP-079
  start: "使い始める", // CP-192
  resume: "再開", // CP-101
  cancelDownload: "DL を取り消す", // CP-102
  status: {
    queued: "待機中",
    downloading: "DL 中",
    retrying: "再試行中",
    verifying: "確認中",
    completed: "完了",
    failed: "失敗",
    cancelled: "取り消し済み",
  } as Record<string, string>, // CP-100
} as const;
