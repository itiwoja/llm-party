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

/** 文脈の使用率を円で見せる。数値は読み上げとホバーで分かる。不明なら輪だけ */
function ContextRing({ percent, warn, label }: { percent: number | null; warn: boolean; label: string }) {
  const value = percent === null ? null : Math.min(100, Math.max(0, percent));
  const text = `${label} ${value === null ? "—" : `${Math.round(value)}%`}`;
  return (
    <svg className={`context-ring${warn ? " context-ring-warning" : ""}`} viewBox="0 0 16 16" role="img" aria-label={text}>
      <title>{text}</title>
      <circle className="context-ring-track" cx="8" cy="8" r="6" />
      {value === null ? null : <circle className="context-ring-value" cx="8" cy="8" r="6" pathLength={100} strokeDasharray={`${value} 100`} />}
    </svg>
  );
}

/** CMP-008。押せない。t/s は数字があるときだけ出す。生成中だけ横に脈打つ点 */
export function Metrics({ status, contextPercent, tokensPerSecond, tools, generating, contextLabel, toolLabel, extra }: Props) {
  const warn = contextPercent !== null && contextPercent > CONTEXT_WARNING_PERCENT;
  return (
    <p className="metrics numeric" aria-live="off">
      <span className="metrics-item"><span className={`dot dot-${status.tone}`} aria-hidden />{status.label}</span>
      {extra}
      <ContextRing percent={contextPercent} warn={warn} label={contextLabel} />
      {tokensPerSecond !== null || generating ? (
        <span className="metrics-item">
          {tokensPerSecond === null ? "—" : tokensPerSecond.toFixed(1)} t/s
          {generating ? <span className="dot dot-pulse" aria-hidden /> : null}
        </span>
      ) : null}
      {tools ? <span className="metrics-item"><span className="metrics-label">{toolLabel}</span> {tools.used}/{tools.max}</span> : null}
    </p>
  );
}
