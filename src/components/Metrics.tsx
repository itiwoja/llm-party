import type { ReactNode } from "react";

interface Props {
  /** 状態の点と語（準備完了など） */
  status: { tone: "ok" | "busy" | "error" | "idle"; label: string };
  /** 文脈の使用率（0〜100）。不明なら null */
  contextPercent: number | null;
  tokensPerSecond: number | null;
  /** エージェントのスレッドだけ。チャットでは渡さない */
  tools?: { used: number; max: number };
  generating?: boolean;
  contextLabel: string;
  toolLabel: string;
  /** 先頭に足す要素（文脈長の表示など） */
  extra?: ReactNode;
}

/** 文脈がこの割合を超えたら警告色（自動要約が近い） */
const CONTEXT_WARNING_PERCENT = 80;

/** CMP-008。押せない。生成中だけ t/s の横に脈打つ点 */
export function Metrics({ status, contextPercent, tokensPerSecond, tools, generating, contextLabel, toolLabel, extra }: Props) {
  const warn = contextPercent !== null && contextPercent > CONTEXT_WARNING_PERCENT;
  return (
    <p className="metrics numeric" aria-live="off">
      <span className="metrics-item"><span className={`dot dot-${status.tone}`} aria-hidden />{status.label}</span>
      {extra}
      <span className="metrics-item"><span className="metrics-label">{contextLabel}</span> <span style={warn ? { color: "var(--color-warning)" } : undefined}>{contextPercent === null ? "—" : `${Math.round(contextPercent)}%`}</span></span>
      <span className="metrics-item">
        {tokensPerSecond === null ? "—" : tokensPerSecond.toFixed(1)} t/s
        {generating ? <span className="dot dot-pulse" aria-hidden /> : null}
      </span>
      {tools ? <span className="metrics-item"><span className="metrics-label">{toolLabel}</span> {tools.used}/{tools.max}</span> : null}
    </p>
  );
}
