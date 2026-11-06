import { isValidElement, memo, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

interface Labels { copy: string; copied: string }

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function components(labels: Labels): Components {
  return {
    // コードブロック。閉じていないものも react-markdown がコードとして渡す（生成中）
    pre({ children }) {
      const child = Array.isArray(children) ? children[0] : children;
      const props = isValidElement<ComponentProps<"code">>(child) ? child.props : {};
      const lang = /language-(\S+)/.exec(props.className ?? "")?.[1];
      return <CodeBlock code={textOf(props.children).replace(/\n$/, "")} lang={lang} copyLabel={labels.copy} copiedLabel={labels.copied} />;
    },
    code({ children, className }) {
      return <code className={["inline-code", className].filter(Boolean).join(" ")}>{children}</code>;
    },
    // リンクは新しいタブで開く
    a({ children, href }) {
      return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
    // 画像は読み込まない（外への通信を増やさない）。代替文字だけ出す
    img({ alt }) {
      return <span>{alt}</span>;
    },
    table({ children }) {
      return <div className="md-table"><table>{children}</table></div>;
    },
  };
}

interface Props extends Labels {
  /** 生成中は届いた分までを渡す。そのつど順に整形される */
  children: string;
}

/**
 * CMP-022（D-57）。生の HTML は rehype-raw を入れていないので実行されず、文字として出る。
 * 文言（コピー / コピー済み）は呼び出し側から受ける
 */
export const Markdown = memo(function Markdown({ children, copy, copied }: Props) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components({ copy, copied })}>{children}</ReactMarkdown>
    </div>
  );
});
