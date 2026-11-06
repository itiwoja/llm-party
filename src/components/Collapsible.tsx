import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/** CMP-006 の土台と、思考（CP-034）の折りたたみ。押せるのは見出しの行全体。矢印だけ回す（MOT-010） */
export function Collapsible({ summary, children, defaultOpen, open, onOpenChange, actions }: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** 見出しの右に置くボタン。押しても開閉しない */
  actions?: ReactNode;
}) {
  const trigger = <RadixCollapsible.Trigger className="collapsible-trigger"><ChevronRight aria-hidden className="collapsible-arrow" />{summary}</RadixCollapsible.Trigger>;
  return (
    <RadixCollapsible.Root className="collapsible" defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange}>
      {actions ? <div className="collapsible-head">{trigger}{actions}</div> : trigger}
      <RadixCollapsible.Content className="collapsible-content">{children}</RadixCollapsible.Content>
    </RadixCollapsible.Root>
  );
}
