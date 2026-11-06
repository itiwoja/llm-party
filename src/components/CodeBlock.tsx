import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { highlight } from "./highlight";

interface Props {
  code: string;
  lang?: string;
  copyLabel: string;
  copiedLabel: string;
}

/** CMP-022 のコードブロック。言語ごとに色分けし、コピーボタンを付ける */
export function CodeBlock({ code, lang, copyLabel, copiedLabel }: Props) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => highlight(code, lang), [code, lang]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境では何もしない（選択してコピーはできる）
    }
  }

  return (
    <figure className="code">
      <figcaption className="code-head">
        <span className="code-lang">{lang ?? ""}</span>
        <button type="button" className="code-copy" onClick={() => void copy()} aria-label={copied ? copiedLabel : copyLabel}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          <span>{copied ? copiedLabel : copyLabel}</span>
        </button>
      </figcaption>
      <pre className="code-body" tabIndex={0}><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </figure>
  );
}
