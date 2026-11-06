import { Ban, Check, CirclePause, Loader, TimerOff, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { TextArea } from "../../components/Field";
import { Collapsible } from "../../components/Collapsible";
import { PG1, MISSING } from "./copy";
import { DiffLines } from "./DiffLines";
import { stripAnsi } from "./ansi";
import type { ToolCall } from "./types";

const ICONS: Record<string, { Icon: typeof Check; tone: string; spin?: boolean }> = {
  pending_approval: { Icon: CirclePause, tone: "warning" },
  running: { Icon: Loader, tone: "muted", spin: true },
  succeeded: { Icon: Check, tone: "success" },
  failed: { Icon: X, tone: "danger" },
  timed_out: { Icon: TimerOff, tone: "danger" },
  rejected: { Icon: Ban, tone: "muted" },
  denied: { Icon: Ban, tone: "muted" },
};

/** 閉じた行に出す対象。パス・コマンド・検索語の順 */
export function targetOf(call: ToolCall): string {
  const args = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
  for (const key of ["path", "command", "pattern"]) {
    if (typeof args[key] === "string" && args[key]) return args[key] as string;
  }
  return "";
}

export type Decide = (call: ToolCall, decision: "approve" | "reject" | "approve_and_auto", note?: string) => Promise<void>;

/** CMP-006。1 行で閉じ、押すと中身が開く。承認待ちは CMP-007 の形で最初から開く */
export function ToolCard({ call, onDecide }: { call: ToolCall; onDecide: Decide }) {
  const { Icon, tone, spin } = ICONS[call.status] ?? ICONS.running;
  const pending = call.status === "pending_approval";
  const target = targetOf(call);
  const output = call.output ? stripAnsi(call.output) : "";
  return (
    <div className={`tool-card${pending ? " tool-card-pending" : ""}`}>
      <Collapsible
        defaultOpen={pending}
        summary={
          <span className="tool-summary">
            <Icon aria-hidden className={`tool-icon tool-${tone}${spin ? " spin" : ""}`} />
            <span className="tool-name">{call.tool}</span>
            {target ? <span className="tool-target">{target}</span> : null}
            <span className="tool-status">{PG1.status[call.status] ?? call.status}</span>
          </span>
        }
      >
        <div className="tool-body">
          {pending ? <ApprovalBody call={call} onDecide={onDecide} /> : null}
          {!pending && call.tool === "run_command" ? <Command call={call} /> : null}
          {!pending && output ? <><p className="tool-label">{MISSING.toolOutput}</p><pre className="tool-output">{output}</pre></> : null}
          {call.decisionNote && !output.includes(call.decisionNote) ? <p className="tool-note">{call.decisionNote}</p> : null}
        </div>
      </Collapsible>
    </div>
  );
}

function Command({ call }: { call: ToolCall }) {
  const args = (call.args && typeof call.args === "object" ? call.args : {}) as { command?: string; cwd?: string };
  return <pre className="tool-output tool-command">{`$ ${args.command ?? ""}${args.cwd ? `\ncwd: ${args.cwd}` : ""}`}</pre>;
}

/** CMP-007。フォーカスは移さない。承認が primary、却下が secondary、以後自動が ghost。この順で Tab */
function ApprovalBody({ call, onDecide }: { call: ToolCall; onDecide: Decide }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (decision: "approve" | "reject" | "approve_and_auto") => {
    setBusy(true);
    try {
      await onDecide(call, decision, decision === "reject" ? note.trim() || undefined : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="group" className="approval-body" aria-label={MISSING.approvalRegion}>
      {call.preview ? <DiffLines diff={call.preview} /> : call.tool === "run_command" ? <Command call={call} /> : null}
      {rejecting ? <TextArea label={PG1.rejectNote} rows={2} value={note} onChange={(e) => setNote(e.target.value)} /> : null}
      <div className="approval-actions">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void run("approve")}>{PG1.approve}</Button>
        <Button size="sm" disabled={busy} onClick={() => (rejecting ? void run("reject") : setRejecting(true))}>{PG1.reject}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run("approve_and_auto")}>{PG1.approveAuto}</Button>
      </div>
    </div>
  );
}
