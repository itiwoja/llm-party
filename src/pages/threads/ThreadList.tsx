import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Collapsible } from "../../components/Collapsible";
import { IconButton } from "../../components/IconButton";
import { ListRow } from "../../components/ListRow";
import { ContextMenu, DropdownMenu, type MenuItem } from "../../components/Menu";
import { CP, MISSING_COPY } from "../../copy";
import { hrefOf, navigate } from "../../router";
import { Ellipsis, Folder, FolderPlus, Plus } from "lucide-react";
import { MISSING, PG1 } from "./copy";
import { groupThreads } from "./group";
import { ProjectDialog } from "./ProjectDialog";
import type { ThreadInfo as Thread, Workspace } from "./types";

interface Props {
  threads: Thread[];
  projects: Workspace[];
  selectedId: string | undefined;
  /** 新しいスレッドの入力画面で選んでいるプロジェクト */
  projectId: string | undefined;
  /** 実行中のスレッド（行の右に状態の点） */
  runningIds: Set<string>;
  onChanged(): void;
  onAddProject(): void;
  onProjectsChanged(): void;
}

const COLLAPSED_KEY = "llm-party.collapsedSections";
/** 「チャット」欄の開閉も、プロジェクトと同じ入れ物で覚える */
const CHATS_SECTION = "chats";

function readCollapsed(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // 覚えられないだけで、開閉はできる
  }
}

/** SEC-001-02：新規・プロジェクト・チャットの一覧。名前変更は API-032、削除は API-033 */
export function ThreadList({ threads, projects, selectedId, projectId, runningIds, onChanged, onAddProject, onProjectsChanged }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Thread | null>(null);
  const [error, setError] = useState("");
  const [configuring, setConfiguring] = useState<Workspace | null>(null);
  const [hiding, setHiding] = useState<Workspace | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const { groups, chats } = groupThreads(threads, projects);

  function setSectionOpen(id: string, open: boolean) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (open) next.delete(id);
      else next.add(id);
      writeCollapsed(next);
      return next;
    });
  }

  // 開いたスレッドが閉じた欄に隠れないようにする
  const selectedSection = threads.find((t) => t.id === selectedId)?.workspaceId;
  useEffect(() => {
    if (selectedSection) setSectionOpen(selectedSection, true);
  }, [selectedSection]);

  async function hideProject(project: Workspace) {
    setHiding(null);
    try {
      await api.delete(`/workspaces/${project.id}`);
      if (project.id === projectId || project.id === selectedSection) navigate("/threads");
      onProjectsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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

  const rows = (list: Thread[], label: string) => (
    <ul className="rows" aria-label={label}>
      {list.map((thread) => (
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
  );

  return (
    <>
      <Button variant="secondary" onClick={() => navigate("/threads")}>{CP.newThread}</Button>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <section className="list-section" aria-label={PG1.projects}>
        <div className="list-heading">
          <h2>{PG1.projects}</h2>
          <IconButton label={PG1.addProject} onClick={onAddProject}><FolderPlus aria-hidden /></IconButton>
        </div>
        {groups.map(({ project, threads: list }) => {
          const menu: MenuItem[] = [
            { label: PG1.newProjectThread, onSelect: () => navigate(`/threads/new/${project.id}`) },
            { label: PG1.projectSettings, onSelect: () => setConfiguring(project) },
            { label: PG1.hideProject, danger: true, onSelect: () => setHiding(project) },
          ];
          return (
            <div key={project.id} className="project" data-selected={project.id === projectId || undefined}>
              <Collapsible
                open={!collapsed.has(project.id)}
                onOpenChange={(open) => setSectionOpen(project.id, open)}
                summary={
                  <ContextMenu menu={menu}>
                    <span className="project-name" title={project.path}><Folder aria-hidden /><span>{project.name}</span></span>
                  </ContextMenu>
                }
                actions={
                  <span className="project-actions">
                    <IconButton label={PG1.newProjectThread} onClick={() => navigate(`/threads/new/${project.id}`)}><Plus aria-hidden /></IconButton>
                    <DropdownMenu trigger={<IconButton label={MISSING_COPY.rowMenu}><Ellipsis aria-hidden /></IconButton>} menu={menu} />
                  </span>
                }
              >
                {list.length === 0 ? <p className="empty">{CP.noThreads}</p> : rows(list, project.name)}
              </Collapsible>
            </div>
          );
        })}
      </section>
      <section className="list-section chats-section" aria-label={PG1.chats}>
        <Collapsible
          open={!collapsed.has(CHATS_SECTION)}
          onOpenChange={(open) => setSectionOpen(CHATS_SECTION, open)}
          summary={<span className="list-section-title">{PG1.chats}</span>}
        >
          {chats.length === 0 ? <p className="empty">{CP.noThreads}</p> : rows(chats, PG1.chats)}
        </Collapsible>
      </section>
      {configuring ? <ProjectDialog key={configuring.id} project={configuring} onClose={() => setConfiguring(null)} onSaved={onProjectsChanged} /> : null}
      <Dialog
        open={hiding !== null}
        onOpenChange={(open) => { if (!open) setHiding(null); }}
        title={hiding ? PG1.confirmHideProject(hiding.name) : ""}
        footer={
          <>
            <Button onClick={() => setHiding(null)}>{CP.cancel}</Button>
            <Button variant="danger" onClick={() => hiding && void hideProject(hiding)}>{PG1.hideProject}</Button>
          </>
        }
      />
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

/** 種類は欄で分かるので読み上げだけ。実行中は点を出す */
function ThreadMark({ thread, running }: { thread: Thread; running: boolean }) {
  return (
    <span className="row-mark">
      <span className="sr-only">{thread.workspaceId !== null ? MISSING.threadKindAgent : MISSING.threadKindChat}</span>
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
