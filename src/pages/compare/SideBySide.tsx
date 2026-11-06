import { useRef } from "react";
import { Button } from "../../components/Button";
import { CP } from "../../copy";
import type { ResultItem } from "../evals/types";
import { ResultBody } from "../runs/ResultBody";
import { StatusMark } from "../runs/StatusMark";
import { PG7, PG7_MISSING } from "./copy";

export interface Side {
  resultId: string;
  status: string;
  score: number | null;
  answer: string | null;
  transcript: ResultItem["transcript"];
  testOutput: string | null;
  tokensPerSec: number | null;
  durationMs: number | null;
}

const asResult = (side: Side, caseName: string): ResultItem => ({
  id: side.resultId, runId: "", caseId: null, caseName, status: side.status, answer: side.answer, transcript: side.transcript,
  testOutput: side.testOutput, score: side.score, reviewedAt: null, tokensPerSec: side.tokensPerSec, durationMs: side.durationMs,
});

/** CMP-018。A・B の応答を左右に並べ、同じ高さでスクロールを連動させる */
export function SideBySide({ caseName, a, b, onClose }: { caseName: string; a: Side; b: Side; onClose(): void }) {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  // 一方を動かすともう一方も動く。反応のはね返りを止めるため、動かされた側の次の 1 回は無視する
  const syncing = useRef<HTMLDivElement | null>(null);

  const follow = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to) return;
    if (syncing.current === from) {
      syncing.current = null;
      return;
    }
    const range = from.scrollHeight - from.clientHeight;
    const ratio = range > 0 ? from.scrollTop / range : 0;
    const target = ratio * (to.scrollHeight - to.clientHeight);
    if (Math.abs(to.scrollTop - target) < 1) return;
    syncing.current = to;
    to.scrollTop = target;
  };

  return (
    <section className="side-by-side" aria-label={PG7_MISSING.caseDetail}>
      <div className="side-head">
        <h2 className="result-title">{caseName}</h2>
        <Button size="sm" variant="ghost" onClick={onClose}>{CP.close}</Button>
      </div>
      <div className="side-grid">
        {([["A", a, left, right, PG7.answerA], ["B", b, right, left, PG7.answerB]] as const).map(([key, side, mine, other, title]) => (
          <div className="side-pane" key={key}>
            <div className="side-pane-head">
              <h3 className="result-heading">{title}</h3>
              <StatusMark status={side.status} />
              {side.score !== null ? <span className="numeric">{side.score}</span> : null}
            </div>
            <div className="side-scroll" ref={mine} onScroll={() => follow(mine.current, other.current)} tabIndex={0} role="region" aria-label={title}>
              <ResultBody result={asResult(side, caseName)} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
