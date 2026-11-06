import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Collapsible } from "../../components/Collapsible";
import { Markdown } from "../../components/Markdown";
import { CP, MISSING_COPY } from "../../copy";
import { PG1 } from "./copy";
import { ToolCard, type Decide } from "./ToolCard";
import type { ThreadMessage, ToolCall } from "./types";

/** 末尾からこの距離以内なら「一番下にいる」とみなして追いかける */
const STICK_PX = 80;

type Item =
  | { kind: "message"; message: ThreadMessage }
  | { kind: "summary"; message: ThreadMessage; folded: ThreadMessage[] }
  | { kind: "tool"; call: ToolCall };

/** メッセージの並び（seq 順）にツールカードを差し込む。tool メッセージは出さず、その位置にカードを置く */
export function buildItems(messages: ThreadMessage[], toolCalls: ToolCall[]): Item[] {
  const calls = new Map(toolCalls.map((c) => [c.id, c]));
  const placed = new Set<string>();
  const folded = messages.filter((m) => m.compactedAt && m.role !== "summary" && m.role !== "tool");
  const items: Item[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const call = m.toolCallId ? calls.get(m.toolCallId) : undefined;
      if (call) { items.push({ kind: "tool", call }); placed.add(call.id); }
    } else if (m.role === "summary") {
      items.push({ kind: "summary", message: m, folded });
    } else if (m.compactedAt) {
      continue;
    } else if (m.role === "user" || m.content || m.reasoning) {
      items.push({ kind: "message", message: m });
    }
  }
  // まだ結果のない呼び出し（承認待ち・実行中）は、そのターンの最後のメッセージの後ろへ
  for (const call of toolCalls) {
    if (placed.has(call.id)) continue;
    let at = -1;
    items.forEach((item, i) => { if (item.kind !== "tool" && item.message.turnId === call.turnId) at = i; });
    // 同じターンの置いたカードの後ろに並べる
    while (at + 1 < items.length && items[at + 1].kind === "tool" && (items[at + 1] as { call: ToolCall }).call.turnId === call.turnId) at++;
    items.splice(at < 0 ? items.length : at + 1, 0, { kind: "tool", call });
  }
  return items;
}

interface Props {
  messages: ThreadMessage[];
  toolCalls: ToolCall[];
  error: string;
  onDecide: Decide;
  /** 40 回上限で止まっているときの確認（CP-047〜049） */
  footer?: ReactNode;
}

/** SEC-001-03：会話（中央 1 列） */
export function Conversation({ messages, toolCalls, error, onDecide, footer }: Props) {
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const items = useMemo(() => buildItems(messages, toolCalls), [messages, toolCalls]);

  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, error, footer]);

  return (
    <div
      className="log"
      ref={log}
      role="log"
      aria-label={MISSING_COPY.conversation}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      }}
    >
      <div className="log-inner">
        {items.map((item) => {
          if (item.kind === "tool") return <ToolCard key={`call-${item.call.id}`} call={item.call} onDecide={onDecide} />;
          const m = item.message;
          if (item.kind === "summary") {
            return (
              <article key={m.id} className="message message-summary">
                <Collapsible summary={PG1.summarized(item.folded.length)}>
                  <div className="summary-body"><Markdown copy={MISSING_COPY.copyCode} copied={MISSING_COPY.copiedCode}>{m.content}</Markdown></div>
                </Collapsible>
              </article>
            );
          }
          return (
            <article key={m.id} className={`message message-${m.role}`}>
              {m.role === "user" ? (
                <div className="user-text">{m.content}</div>
              ) : (
                <>
                  {m.reasoning ? <Collapsible summary={CP.thinking}><div className="reasoning">{m.reasoning}</div></Collapsible> : null}
                  {m.content ? <Markdown copy={MISSING_COPY.copyCode} copied={MISSING_COPY.copiedCode}>{m.content}</Markdown> : null}
                </>
              )}
            </article>
          );
        })}
        {footer}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
      </div>
    </div>
  );
}
