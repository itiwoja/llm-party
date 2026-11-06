import { CircleAlert } from "lucide-react";
import { Collapsible } from "../../components/Collapsible";
import { Markdown } from "../../components/Markdown";
import { CP, MISSING_COPY } from "../../copy";
import { ToolCard } from "../threads/ToolCard";
import type { ToolCall } from "../threads/types";
import "../threads/threads.css";
import type { ResultItem } from "../evals/types";
import { PG6 } from "./copy";

const noDecision = async () => undefined;

/** 結果の ToolLog を CMP-006 の形に直す。評価は自動承認なので承認待ちにはならない */
function toolCalls(result: ResultItem): ToolCall[] {
  return (result.transcript?.toolCalls ?? []).map((log, index) => ({
    id: `${result.id}-${index}`, turnId: "", tool: log.tool, args: log.args, kind: "", status: log.status,
    output: log.output ?? null, exitCode: log.exitCode ?? null, decisionNote: null,
  }));
}

/** 応答・ツール呼び出し・テストの出力（SEC-006-03, CMP-018 の片側）。CMP-006 は threads の部品を読むだけで使う */
export function ResultBody({ result }: { result: ResultItem }) {
  const calls = toolCalls(result);
  const error = result.transcript?.error;
  return (
    <div className="result-body">
      {error ? <p className="field-error" role="alert"><CircleAlert aria-hidden />{error}</p> : null}
      <section>
        <h4 className="result-heading">{PG6.headings.answer}</h4>
        {result.transcript?.reasoning ? <Collapsible summary={CP.thinking}><div className="reasoning">{result.transcript.reasoning}</div></Collapsible> : null}
        {result.answer ? <Markdown copy={MISSING_COPY.copyCode} copied={MISSING_COPY.copiedCode}>{result.answer}</Markdown> : <p className="empty">—</p>}
      </section>
      {calls.length ? (
        <section>
          <h4 className="result-heading">{PG6.headings.tools}</h4>
          <div className="result-tools">{calls.map((call) => <ToolCard key={call.id} call={call} onDecide={noDecision} />)}</div>
        </section>
      ) : null}
      {result.testOutput ? (
        <section>
          <h4 className="result-heading">{PG6.headings.testOutput}</h4>
          <pre className="tool-output">{result.testOutput}</pre>
        </section>
      ) : null}
    </div>
  );
}
