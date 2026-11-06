import { classifyDiff } from "./diff";

/** CMP-010 の本体。unified の文字列を行ごとに色分けする。行頭に + と − を必ず出す（色だけで伝えない） */
export function DiffLines({ diff }: { diff: string }) {
  const lines = classifyDiff(diff);
  return (
    <pre className="diff" tabIndex={0}>
      {lines.map((line, i) => (
        <span key={i} className={`diff-line diff-${line.kind}`}>
          <span className="diff-sign" aria-hidden>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
          {line.kind === "add" ? <span className="sr-only">+</span> : line.kind === "del" ? <span className="sr-only">−</span> : null}
          {line.text}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
