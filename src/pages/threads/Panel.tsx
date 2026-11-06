import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError } from "../../api";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { RadioField } from "../../components/Controls";
import { IconButton } from "../../components/IconButton";
import { Tabs } from "../../components/Tabs";
import { PG1, MISSING } from "./copy";
import { countChanges, unifiedDiff } from "./diff";
import { DiffLines } from "./DiffLines";
import { stripAnsi } from "./ansi";
import type { FileChange, ToolCall } from "./types";

/** 端末ビューが 1 コマンドにつき持つ文字数の上限。設計書に値がないので仮（報告の「未確定の値」） */
export const TERMINAL_MAX_CHARS = 200_000;
/** 一番下からこの距離以内なら追いかける */
const STICK_PX = 40;

interface Props {
  tab: string;
  onTabChange(tab: string): void;
  onClose(): void;
  changes: FileChange[];
  /** 承認待ちの書き込み（差分のプレビューつき） */
  pendingWrites: ToolCall[];
  commands: ToolCall[];
  live: Record<string, string>;
  /** 取り消し。編集済みなら ApiRequestError(409) を投げる */
  onRevert(change: FileChange, force: boolean): Promise<void>;
}

/** SEC-001-05：右パネル。差分（CMP-010）と端末（CMP-011） */
export function Panel({ tab, onTabChange, onClose, changes, pendingWrites, commands, live, onRevert }: Props) {
  return (
    <div className="panel-inner" role="region" aria-label={MISSING.panel}>
      <div className="panel-close"><IconButton label={PG1.close} onClick={onClose}><X aria-hidden /></IconButton></div>
      <Tabs
        value={tab}
        onValueChange={onTabChange}
        ariaLabel={MISSING.panel}
        tabs={[
          { value: "diff", label: PG1.tabDiff, content: <DiffTab changes={changes} pendingWrites={pendingWrites} onRevert={onRevert} /> },
          { value: "terminal", label: PG1.tabTerminal, content: <TerminalView commands={commands} live={live} /> },
        ]}
      />
    </div>
  );
}

interface Entry { key: string; path: string; pending?: ToolCall; changes: FileChange[] }

function DiffTab({ changes, pendingWrites, onRevert }: Pick<Props, "changes" | "pendingWrites" | "onRevert">) {
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState("merged");
  const [conflict, setConflict] = useState<{ queue: FileChange[] } | null>(null);
  const [error, setError] = useState("");

  const entries = useMemo<Entry[]>(() => {
    const byPath = new Map<string, FileChange[]>();
    for (const change of changes) byPath.set(change.path, [...(byPath.get(change.path) ?? []), change]);
    const pendings = pendingWrites.map((call): Entry => ({
      key: `pending:${call.id}`,
      path: String((call.args as { path?: string } | null)?.path ?? ""),
      pending: call,
      changes: [],
    }));
    return [...pendings, ...[...byPath].map(([path, list]): Entry => ({ key: path, path, changes: list }))];
  }, [changes, pendingWrites]);

  const current = entries.find((e) => e.key === selected) ?? entries[0];

  async function revertQueue(queue: FileChange[], force: boolean) {
    setError("");
    for (const [index, change] of queue.entries()) {
      try {
        await onRevert(change, force);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 409 && !force) setConflict({ queue: queue.slice(index) });
        else setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
  }

  if (entries.length === 0) return <p className="empty">{PG1.noChanges}</p>;

  const live = current.changes.filter((c) => !c.revertedAt);
  const newestFirst = [...live].reverse();
  return (
    <div className="diff-tab">
      <ul className="file-list" aria-label={MISSING.fileList}>
        {entries.map((entry) => {
          const diff = entry.pending ? entry.pending.preview ?? "" : fileDiff(entry);
          const { added, removed } = countChanges(diff);
          return (
            <li key={entry.key}>
              <button type="button" className="file-item" aria-current={entry.key === current.key ? "true" : undefined} onClick={() => setSelected(entry.key)}>
                <span className="file-path">{entry.path}</span>
                <span className="numeric file-count"><span className="count-add">+{added}</span> <span className="count-del">−{removed}</span></span>
              </button>
            </li>
          );
        })}
      </ul>
      {current.pending ? (
        <DiffLines diff={current.pending.preview ?? ""} />
      ) : (
        <>
          {current.changes.length > 1 ? <RadioField label={MISSING.diffMode} value={mode} onValueChange={setMode} options={[{ value: "merged", label: MISSING.merged }, { value: "steps", label: MISSING.perStep }]} /> : null}
          {mode === "steps" && current.changes.length > 1
            ? current.changes.map((change) => (
                <div key={change.id} className="step-diff">
                  {change.revertedAt ? <p className="tool-label">{MISSING.reverted}</p> : null}
                  <DiffLines diff={changeDiff(change)} />
                  {!change.revertedAt ? <Button size="sm" onClick={() => void revertQueue([change], false)}>{PG1.revert}</Button> : null}
                </div>
              ))
            : (
              <>
                {live.length ? <DiffLines diff={fileDiff(current)} /> : <p className="empty">{current.changes.length ? MISSING.reverted : PG1.noChanges}</p>}
                {live.length ? <Button size="sm" onClick={() => void revertQueue(newestFirst, false)}>{PG1.revert}</Button> : null}
              </>
            )}
        </>
      )}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <Dialog
        open={conflict !== null}
        onOpenChange={(open) => { if (!open) setConflict(null); }}
        title={PG1.revertConflict}
        footer={
          <>
            <Button onClick={() => setConflict(null)}>{PG1.cancel}</Button>
            <Button variant="danger" onClick={() => { const queue = conflict?.queue ?? []; setConflict(null); void revertQueue(queue, true); }}>{PG1.revert}</Button>
          </>
        }
      />
    </div>
  );
}

const changeDiff = (c: FileChange) => unifiedDiff(c.path, c.before, c.after);

/** まとめた差分：戻していない変更の最初の前から最後の後まで */
function fileDiff(entry: Entry): string {
  const live = entry.changes.filter((c) => !c.revertedAt);
  if (live.length === 0) return "";
  return unifiedDiff(entry.path, live[0].before, live.at(-1)!.after);
}

/** CMP-011。コマンドごとに区切り、終了コードを右に等幅で。自動スクロールは一番下にいるときだけ */
function TerminalView({ commands, live }: { commands: ToolCall[]; live: Record<string, string> }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [commands, live]);
  if (commands.length === 0) return <p className="empty">{PG1.noCommands}</p>;
  return (
    <div
      className="terminal"
      ref={box}
      tabIndex={0}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX; }}
    >
      {commands.map((call) => {
        const args = (call.args && typeof call.args === "object" ? call.args : {}) as { command?: string };
        const raw = stripAnsi(live[call.id] ?? call.output ?? "");
        const cut = raw.length > TERMINAL_MAX_CHARS;
        return (
          <section key={call.id} className="terminal-block">
            <header className="terminal-head">
              <span className="terminal-cmd">$ {args.command}</span>
              {call.exitCode !== null && call.exitCode !== undefined ? <span className="numeric terminal-exit">{MISSING.exitCode} {call.exitCode}</span> : null}
            </header>
            {cut ? <p className="tool-label">{MISSING.truncatedOutput}</p> : null}
            <pre className="terminal-out">{cut ? raw.slice(-TERMINAL_MAX_CHARS) : raw}</pre>
          </section>
        );
      })}
    </div>
  );
}
