import type { ChatMessage } from "./stream";

/** BR-04・ADR-006：使用量がこの割合を超えたら要約する */
export const COMPACT_RATIO = 0.8;
/** D-42：要約せずに残す直近のメッセージ数 */
export const KEEP_RECENT = 6;
/** 要約の生成の上限。設計書にない値（仮） */
export const SUMMARY_MAX_TOKENS = 2048;
/** 要約の元にする、ツール結果・呼び出し引数の1件あたりの長さ。設計書にない値（仮） */
export const EXCERPT_CHARS = 1000;
/** CP-050。要約しても 100% を超えたときの turn.finished の error */
export const CONTEXT_FULL = "文脈が満杯。新しいスレッドで続行";

/** 要約の候補にする保存済みメッセージ（compacted_at が空のもの） */
export interface CompactRow {
  id: string;
  seq: number;
  role: string;
  content: string;
  pinned: boolean;
  /** tool メッセージの呼び出し */
  tool?: string | null;
  args?: string | null;
}

export interface CompactionPlan {
  /** 要約して compacted_at を付けるもの（古い順） */
  middle: CompactRow[];
  /** 残す側の最初のメッセージの seq。要約はこの位置に入る */
  keepFromSeq: number;
}

export const needsCompaction = (usedTokens: number, contextSize: number) => usedTokens > contextSize * COMPACT_RATIO;
export const isContextFull = (usedTokens: number, contextSize: number) => usedTokens > contextSize;

/**
 * FR-006：何を要約して何を残すか。最初の指示（pinned）と直近 KEEP_RECENT 件は残す。
 * 残す側の先頭が tool なら、その呼び出しを出した assistant まで遡る（結果のない呼び出し・呼び出しのない結果を作らない）。
 * 要約するものがなければ null
 */
export function planCompaction(rows: CompactRow[], keep = KEEP_RECENT): CompactionPlan | null {
  // 失敗・停止で空のまま残った assistant（tool_calls もない）は会話に出ないので数えない
  const candidates = rows.filter((row, index) => !row.pinned && !(row.role === "assistant" && row.content === "" && rows[index + 1]?.role !== "tool"));
  let start = candidates.length - keep;
  while (start > 0 && candidates[start].role === "tool") start -= 1;
  if (start <= 0) return null;
  const middle = candidates.slice(0, start);
  // 前回の要約だけでは、もう一度要約しても縮まない
  if (middle.every((row) => row.role === "summary")) return null;
  return { middle, keepFromSeq: candidates[start].seq };
}

const clip = (text: string) => (text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…（以下省略）` : text);

/** 要約を頼む1通のメッセージ。ツールの組はテキストにして渡す（要約の要求にはツールを付けない） */
export function summaryRequest(middle: CompactRow[]): ChatMessage[] {
  const lines = middle.filter((row) => row.role !== "assistant" || row.content !== "").map((row) => {
    if (row.role === "tool") return `[ツール ${row.tool ?? ""} ${clip(row.args ?? "")}] ${clip(row.content)}`;
    if (row.role === "summary") return `[前回の要約]\n${row.content}`;
    return `[${row.role === "user" ? "利用者" : "アシスタント"}] ${clip(row.content)}`;
  });
  return [{
    role: "user",
    content: [
      "次の会話の古い部分を、続きの作業ができるように要約してください。",
      "見出しは「目的」「決まったこと」「触ったファイル」「残りの作業」の4つにします。",
      "",
      "---",
      ...lines,
    ].join("\n"),
  }];
}

/** モデルに渡すときの要約。system はテンプレートが先頭以外を受け付けないので user にする */
export const summaryMessage = (content: string): { role: "user"; content: string } => ({ role: "user", content: `これまでの会話の要約:\n${content}` });

/** 文脈の量を数えるためのテキスト（tool_calls は名前と引数を含める） */
export function messageText(message: ChatMessage): string {
  if (message.role === "assistant" && message.tool_calls) {
    return [message.content, ...message.tool_calls.map((call) => `${call.function.name} ${call.function.arguments}`)].join("\n");
  }
  return message.content;
}
