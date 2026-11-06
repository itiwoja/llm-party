import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";
import { ListRow } from "../../components/ListRow";
import { SearchField } from "../../components/SearchField";
import { CP, MISSING_COPY } from "../../copy";
import { hrefOf, navigate } from "../../router";
import { Folder, MessageSquare } from "lucide-react";
import { MISSING } from "./copy";
import type { ThreadInfo as Thread } from "./types";

interface Props {
  threads: Thread[];
  selectedId: string | undefined;
  query: string;
  onQueryChange(q: string): void;
  /** 実行中のスレッド（行の右に状態の点） */
  runningIds: Set<string>;
  onChanged(): void;
}

/** SEC-001-02：新規・検索・スレッドの一覧。名前変更は API-032、削除は API-033 */
export function ThreadList({ threads, selectedId, query, onQueryChange, runningIds, onChanged }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Thread | null>(null);
  const [error, setError] = useState("");

  async function rename(thread: Thread, title: string) {
    setRenamingId(null);
    const next = title.trim();
    if (!next || next === thread.title) return;
    try {
      await api.patch(`/threads/${thread.id}`, { title: next });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(thread: Thread) {
    setDeleting(null);
    try {
      await api.delete(`/threads/${thread.id}`);
      if (thread.id === selectedId) navigate("/threads");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => navigate("/threads")}>{CP.newThread}</Button>
      <SearchField value={query} onChange={onQueryChange} label={CP.searchThreads} clearLabel={MISSING_COPY.clearSearch} />
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {threads.length === 0 ? <p className="empty">{query.trim() ? CP.noThreadResults : CP.noThreads}</p> : null}
      <ul className="rows" aria-label={CP.nav.threads}>
        {threads.map((thread) => (
          <ListRow
            key={thread.id}
            title={thread.title}
            href={hrefOf(`/threads/${thread.id}`)}
            selected={thread.id === selectedId}
            status={<ThreadMark thread={thread} running={runningIds.has(thread.id)} />}
            menuLabel={MISSING_COPY.rowMenu}
            menu={[
              { label: CP.renameThread, onSelect: () => setRenamingId(thread.id) },
              { label: CP.delete, danger: true, onSelect: () => setDeleting(thread) },
            ]}
            editing={renamingId === thread.id ? <RenameInput initial={thread.title} onDone={(title) => void rename(thread, title)} /> : undefined}
          />
        ))}
      </ul>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={deleting ? CP.confirmDeleteThread(deleting.title) : ""}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{CP.cancel}</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>{CP.delete}</Button>
          </>
        }
      />
    </>
  );
}

/** 種類の印（チャット / エージェント）。エージェントは作業フォルダ名も出す */
function ThreadMark({ thread, running }: { thread: Thread; running: boolean }) {
  const agent = thread.workspaceId !== null;
  const Icon = agent ? Folder : MessageSquare;
  return (
    <span className="row-mark">
      {agent && thread.workspaceName ? <span className="row-workspace">{thread.workspaceName}</span> : null}
      <Icon aria-hidden className="row-kind" />
      <span className="sr-only">{agent ? MISSING.threadKindAgent : MISSING.threadKindChat}</span>
      {running ? <span className="dot dot-pulse" aria-hidden /> : null}
    </span>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone(title: string): void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => ref.current?.select(), []);
  const finish = (title: string) => {
    if (settled.current) return;
    settled.current = true;
    onDone(title);
  };
  return (
    <input
      ref={ref}
      className="input"
      value={value}
      aria-label={CP.renameThread}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(initial);
      }}
    />
  );
}
