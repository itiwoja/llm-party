import { PanelRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiRequestError } from "../../api";
import { useAppData, useBand, useServerEvent } from "../../app-data";
import { Button } from "../../components/Button";
import { ComposerInput } from "../../components/ComposerInput";
import { SelectField } from "../../components/Controls";
import { IconButton } from "../../components/IconButton";
import { Metrics } from "../../components/Metrics";
import { CP, MISSING_COPY } from "../../copy";
import { WorkLayout } from "../../layouts";
import { navigate, useRoute } from "../../router";
import { pickFolder } from "../../platform";
import type { EngineState } from "../../types";
import { Conversation } from "./Conversation";
import { PG1, MISSING } from "./copy";
import { Panel, TERMINAL_MAX_CHARS } from "./Panel";
import { ThreadList } from "./ThreadList";
import type { Decide } from "./ToolCard";
import type { FileChange, ThreadInfo, ThreadMessage, ToolCall, TurnInfo, Workspace } from "./types";
import "./threads.css";

const ENGINE_STATUS: Record<EngineState, { tone: "ok" | "busy" | "error" | "idle"; label: string }> = {
  ready: { tone: "ok", label: MISSING_COPY.engineReady },
  starting: { tone: "busy", label: MISSING_COPY.engineStarting },
  stopped: { tone: "idle", label: MISSING_COPY.engineStopped },
  failed: { tone: "error", label: MISSING_COPY.engineFailed },
};

/** D-24：1 指示のツール呼び出しの上限（まだターンがないときの表示用） */
const STEP_LIMIT = 40;
const ACTIVE_TURN: TurnInfo["status"][] = ["running", "awaiting_approval", "step_limit"];

interface Usage { percent: number | null; tokensPerSecond: number | null }

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** API-039 の応答の形は未確定。TBL-009 の列名（camel でも snake でも）から読む */
function toChange(raw: Record<string, any>): FileChange {
  return {
    id: raw.id,
    toolCallId: raw.toolCallId ?? raw.tool_call_id ?? "",
    path: raw.path,
    before: raw.before ?? raw.beforeContent ?? raw.before_content ?? null,
    after: raw.after ?? raw.afterContent ?? raw.after_content ?? null,
    revertedAt: raw.revertedAt ?? raw.reverted_at ?? null,
    createdAt: raw.createdAt ?? raw.created_at ?? "",
  };
}

/** PG-001 メイン（作業の型）。エージェントは作業フォルダ付きのスレッド */
export function ThreadsPage() {
  const route = useRoute();
  const threadId = route.page === "threads" ? route.id : undefined;
  const { presets, engine } = useAppData();

  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [query, setQuery] = useState("");
  const [presetId, setPresetId] = useState("");
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [turns, setTurns] = useState<TurnInfo[]>([]);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [live, setLive] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [turn, setTurn] = useState<{ id: string; threadId: string } | null>(null);
  const [stepWait, setStepWait] = useState(false);
  const [usage, setUsage] = useState<Usage>({ percent: null, tokensPerSecond: null });
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [looped, setLooped] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState("diff");
  const [evalProgress, setEvalProgress] = useState<{ done: number; total: number } | null>(null);

  const composer = useRef<HTMLTextAreaElement>(null);
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  const queryRef = useRef(query);
  queryRef.current = query;
  const toolCallsRef = useRef(toolCalls);
  toolCallsRef.current = toolCalls;
  const listSeq = useRef(0);

  const thread = threads.find((t) => t.id === threadId);
  const isAgent = Boolean(thread?.workspaceId);
  const pendingCalls = useMemo(() => toolCalls.filter((c) => c.status === "pending_approval"), [toolCalls]);

  useBand("truncated", truncated ? { kind: "warning", message: CP.truncated } : null);
  useBand("looped", looped ? { kind: "warning", message: CP.looped } : null);
  useBand("approval", pendingCalls.length > 0 ? { kind: "warning", message: PG1.bandApproval(pendingCalls.length) } : null);
  useBand("eval", evalProgress ? { kind: "info", busy: true, message: PG1.bandEval(evalProgress.done, evalProgress.total) } : null);

  const loadThreads = useCallback(async () => {
    const seq = ++listSeq.current;
    const q = queryRef.current.trim();
    const { items } = await api<{ items: ThreadInfo[] }>(`/threads${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    if (seq === listSeq.current) setThreads(items);
  }, []);

  /** messages・turns・toolCalls から画面を戻す。動いているターンもここで見つける（開き直し） */
  const presetsRef = useRef(presets);
  presetsRef.current = presets;

  const loadDetail = useCallback(async (id: string) => {
    const detail = await api<{ messages: ThreadMessage[]; turns: TurnInfo[]; toolCalls: ToolCall[] }>(`/threads/${id}/messages`);
    if (threadRef.current !== id) return;
    // 生成中の文字は DB より画面の方が新しいので、長い方を残す
    setMessages((prev) => detail.messages.map((m) => {
      const local = prev.find((p) => p.id === m.id);
      return local && local.content.length > m.content.length ? { ...m, content: local.content, reasoning: local.reasoning } : m;
    }));
    setToolCalls(detail.toolCalls);
    setTurns(detail.turns);
    const last = detail.turns.at(-1);
    // 開き直しても文脈の使用量を出す（FR-006）。生成中は turn.usage が上書きする
    const size = presetsRef.current.find((p) => p.id === last?.presetId)?.contextSize;
    if (last?.promptTokens != null && size) {
      const used = last.promptTokens + (last.completionTokens ?? 0);
      setUsage((current) => (current.percent === null ? { ...current, percent: (used / size) * 100 } : current));
    }
    if (last && ACTIVE_TURN.includes(last.status)) {
      setTurn({ id: last.id, threadId: id });
      setStepWait(last.status === "step_limit");
    } else if (turnRef.current?.threadId === id && (!last || !detail.turns.some((t) => t.id === turnRef.current?.id && ACTIVE_TURN.includes(t.status)))) {
      setTurn(null);
      setStepWait(false);
    }
  }, []);

  const loadChanges = useCallback(async (id: string) => {
    try {
      const res = await api<{ items?: Record<string, any>[] } | Record<string, any>[]>(`/threads/${id}/changes`);
      const items = Array.isArray(res) ? res : res.items ?? [];
      if (threadRef.current === id) setChanges(items.map(toChange));
    } catch {
      // 変更記録がまだ無いサーバーでも画面は動かす
      if (threadRef.current === id) setChanges([]);
    }
  }, []);

  useEffect(() => { void loadThreads().catch(() => undefined); }, [loadThreads, query]);

  // プリセットは初期値として先頭。スレッドを開いたら最後に使ったものへ
  useEffect(() => {
    setPresetId((current) => {
      const last = threads.find((t) => t.id === threadId)?.lastPresetId;
      if (last && presets.some((p) => p.id === last)) return last;
      return presets.some((p) => p.id === current) ? current : presets[0]?.id ?? "";
    });
    // threads は一覧の更新ごとに変わるので、開いたスレッドが変わったときとプリセットが届いたときだけ見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, presets]);

  useEffect(() => {
    setError("");
    setTruncated(false);
    setLooped(false);
    setUsage({ percent: null, tokensPerSecond: null });
    setMessages([]);
    setToolCalls([]);
    setTurns([]);
    setChanges([]);
    setLive({});
    setWorkspace(null);
    setWorkspaceError("");
    setPanelOpen(false);
    if (threadId) {
      void loadDetail(threadId).catch((err) => setError(errorText(err)));
      void loadChanges(threadId);
    }
    composer.current?.focus();
  }, [threadId, loadDetail, loadChanges]);

  // 承認待ちが増えたら右パネルを自動で開く（書き込みなら差分）
  const pendingKey = pendingCalls.map((c) => c.id).join(",");
  const seenPending = useRef("");
  useEffect(() => {
    if (pendingKey && pendingKey !== seenPending.current) {
      setPanelOpen(true);
      if (pendingCalls.some((c) => c.preview)) setPanelTab("diff");
    }
    seenPending.current = pendingKey;
    // pendingCalls は pendingKey から決まる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  // 生成中の文字とコマンドの出力の更新はフレームごとにまとめる
  const pending = useRef(new Map<string, { content: string; reasoning: string; turnId: string }>());
  const outputs = useRef(new Map<string, string>());
  const frame = useRef(0);
  const flush = useCallback(() => {
    frame.current = 0;
    const batch = pending.current;
    if (batch.size > 0) {
      pending.current = new Map();
      setMessages((list) => {
        let next = list;
        for (const [id, add] of batch) {
          if (next.some((m) => m.id === id)) {
            next = next.map((m) => (m.id === id ? { ...m, content: m.content + add.content, reasoning: add.reasoning ? (m.reasoning ?? "") + add.reasoning : m.reasoning } : m));
          } else {
            next = [...next, { id, turnId: add.turnId, role: "assistant", content: add.content, reasoning: add.reasoning || null }];
          }
        }
        return next;
      });
    }
    const out = outputs.current;
    if (out.size > 0) {
      outputs.current = new Map();
      setLive((current) => {
        const next = { ...current };
        for (const [id, chunk] of out) {
          const joined = (next[id] ?? "") + chunk;
          next[id] = joined.length > TERMINAL_MAX_CHARS * 2 ? joined.slice(-TERMINAL_MAX_CHARS) : joined;
        }
        return next;
      });
    }
  }, []);
  const schedule = () => { if (!frame.current) frame.current = requestAnimationFrame(flush); };
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  useServerEvent(({ event, data }) => {
    const active = turnRef.current;
    const here = active && active.threadId === threadRef.current ? active : null;
    if (event === "turn.delta" && here && data.turnId === here.id) {
      const entry = pending.current.get(data.messageId) ?? { content: "", reasoning: "", turnId: here.id };
      entry.content += data.content ?? "";
      entry.reasoning += data.reasoning ?? "";
      pending.current.set(data.messageId, entry);
      schedule();
    } else if (event === "turn.usage" && active && data.turnId === active.id) {
      const size = data.contextSize || presets.find((p) => p.id === presetId)?.contextSize;
      setUsage({
        percent: data.usedTokens !== null && size ? (data.usedTokens / size) * 100 : null,
        tokensPerSecond: data.tokensPerSecond || null,
      });
    } else if (event === "tool.pending" && here) {
      setToolCalls((list) => [...list.filter((c) => c.id !== data.toolCallId), {
        id: data.toolCallId, turnId: here.id, tool: data.tool, args: data.args, kind: "", status: "pending_approval",
        output: null, exitCode: null, decisionNote: null, preview: data.preview,
      }]);
    } else if (event === "tool.started" && here) {
      // tool.started はツール名を持たない。知らない id なら読み直す
      if (toolCallsRef.current.some((c) => c.id === data.toolCallId)) {
        setToolCalls((list) => list.map((c) => (c.id === data.toolCallId ? { ...c, status: "running" } : c)));
      } else {
        void loadDetail(here.threadId).catch(() => undefined);
      }
    } else if (event === "tool.output" && here) {
      outputs.current.set(data.toolCallId, (outputs.current.get(data.toolCallId) ?? "") + data.chunk);
      schedule();
    } else if (event === "tool.finished" && here) {
      setToolCalls((list) => list.map((c) => (c.id === data.toolCallId ? { ...c, status: data.status, exitCode: data.exitCode ?? c.exitCode } : c)));
      // 出力と呼び出し回数は保存した側にある
      void loadDetail(here.threadId).catch(() => undefined);
      void loadChanges(here.threadId);
    } else if (event === "turn.stepLimit" && here && data.turnId === here.id) {
      setStepWait(true);
      void loadDetail(here.threadId).catch(() => undefined);
    } else if (event === "turn.finished" && active && data.turnId === active.id) {
      if (frame.current) cancelAnimationFrame(frame.current);
      flush();
      setTurn(null);
      setStepWait(false);
      setLive({});
      // 文脈満杯は入力欄の下に出す（ターンの error から導く）
      if (data.error && data.error !== PG1.contextFull) setError(data.error);
      else if (data.truncated) setTruncated(true);
      else if (data.looped) setLooped(true);
      if (threadRef.current === active.threadId) {
        void loadDetail(active.threadId).catch(() => undefined);
        void loadChanges(active.threadId);
      }
      void loadThreads();
    } else if (event === "eval.progress") {
      setEvalProgress({ done: data.done, total: data.total });
    } else if (event === "eval.finished") {
      setEvalProgress(null);
    }
  });

  async function send() {
    const content = input.trim();
    if (!content || turn || !presetId) return;
    setError("");
    setTruncated(false);
    setLooped(false);
    try {
      const id = threadId ?? (await api<ThreadInfo>("/threads", { presetId, ...(workspace ? { workspaceId: workspace.id } : {}) })).id;
      threadRef.current = id;
      const started = await api<{ turnId: string }>(`/threads/${id}/turns`, { presetId, content });
      setTurn({ id: started.turnId, threadId: id });
      setInput("");
      if (id !== threadId) navigate(`/threads/${id}`, true);
      await loadDetail(id);
      await loadThreads();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function chooseFolder() {
    setWorkspaceError("");
    const path = await pickFolder();
    if (!path) return;
    try {
      setWorkspace(await api<Workspace>("/workspaces", { path }));
    } catch (err) {
      setWorkspaceError(err instanceof ApiRequestError && err.code === "PATH_NOT_ALLOWED" ? PG1.pathNotAllowed : errorText(err));
    }
  }

  const decide: Decide = async (call, decision, note) => {
    try {
      await api(`/tool-calls/${call.id}/decision`, { decision, ...(note ? { note } : {}) });
      setToolCalls((list) => list.map((c) => (c.id === call.id ? { ...c, status: decision === "reject" ? "rejected" : "running", decisionNote: note ?? c.decisionNote } : c)));
    } catch (err) {
      setError(errorText(err));
      if (threadId) void loadDetail(threadId).catch(() => undefined);
    }
  };

  async function answerStepLimit(action: "continue" | "stop") {
    if (!turn) return;
    try {
      await api(`/turns/${turn.id}/continue`, { action });
      setStepWait(false);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function revert(change: FileChange, force: boolean) {
    await api(`/file-changes/${change.id}/revert`, force ? { force: true } : {});
    if (threadId) await loadChanges(threadId);
  }

  async function continueInNewThread() {
    if (!threadId) return;
    try {
      const created = await api<ThreadInfo>("/threads", {
        presetId,
        ...(thread?.workspaceId ? { workspaceId: thread.workspaceId } : {}),
        summaryFromThreadId: threadId,
      });
      await loadThreads();
      navigate(`/threads/${created.id}`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const generating = turn !== null && turn.threadId === threadId;
  const contextSize = presets.find((p) => p.id === presetId)?.contextSize;
  const runningIds = new Set(turn ? [turn.threadId] : []);
  const lastTurn = turns.at(-1);
  const contextFull = !generating && lastTurn?.status === "failed" && lastTurn.error === PG1.contextFull;
  const turnError = !generating && lastTurn?.status === "failed" && lastTurn.error && !contextFull ? lastTurn.error : "";
  const agentView = isAgent || workspace !== null;
  const workspaceName = thread?.workspaceName ?? workspace?.name;
  const commands = toolCalls.filter((c) => c.tool === "run_command" && c.status !== "pending_approval");

  const panel = isAgent && panelOpen ? (
    <Panel
      tab={panelTab}
      onTabChange={setPanelTab}
      onClose={() => setPanelOpen(false)}
      changes={changes}
      pendingWrites={pendingCalls.filter((c) => c.preview)}
      commands={commands}
      live={live}
      onRevert={revert}
    />
  ) : null;

  return (
    <WorkLayout
      list={
        <ThreadList
          threads={threads}
          selectedId={threadId}
          query={query}
          onQueryChange={setQuery}
          runningIds={runningIds}
          onChanged={() => void loadThreads()}
        />
      }
      panel={panel}
    >
      <h1 className="sr-only">{CP.nav.threads}</h1>
      <header className="thread-head">
        <SelectField
          title
          hideLabel
          label={MISSING_COPY.presetSelect}
          value={presetId}
          onValueChange={setPresetId}
          options={presets.map((p) => ({ value: p.id, label: p.name }))}
          disabled={generating}
        />
        {contextSize ? <span className="numeric head-context">{Math.round(contextSize / 1024)}K</span> : null}
        {isAgent && !panelOpen ? <IconButton label={MISSING.openPanel} className="head-panel" onClick={() => setPanelOpen(true)}><PanelRight aria-hidden /></IconButton> : null}
      </header>
      <Conversation
        messages={messages}
        toolCalls={toolCalls}
        error={error || turnError}
        onDecide={decide}
        footer={generating && stepWait ? (
          <div className="step-limit" role="group" aria-label={PG1.stepLimit}>
            <p>{PG1.stepLimit}</p>
            <div className="approval-actions">
              <Button variant="primary" size="sm" onClick={() => void answerStepLimit("continue")}>{PG1.continue}</Button>
              <Button size="sm" onClick={() => void answerStepLimit("stop")}>{PG1.stop}</Button>
            </div>
          </div>
        ) : null}
      />
      <form className="composer-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <ComposerInput
          ref={composer}
          id="composer"
          label={CP.instruction}
          placeholder={CP.instructionPlaceholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onSubmit={() => void send()}
        />
        {generating
          ? <Button variant="secondary" tone="danger" disabled={stepWait} onClick={() => turn && void api.post(`/turns/${turn.id}/cancel`).catch((err) => setError(errorText(err)))}>{CP.stop}</Button>
          : <Button type="submit" variant="primary" disabled={!input.trim() || !presetId || turn !== null}>{CP.send}</Button>}
      </form>
      {contextFull ? (
        <div className="context-full" role="alert">
          <p className="field-error">{PG1.contextFull}</p>
          <Button size="sm" onClick={() => void continueInNewThread()}>{PG1.continueInNew}</Button>
        </div>
      ) : null}
      <div className="workspace-row">
        {!threadId ? <Button size="sm" onClick={() => void chooseFolder()}>{PG1.pickFolder}</Button> : null}
        {workspaceName ? <span className="workspace-name">{PG1.workspace(workspaceName)}</span> : null}
        {workspaceError ? <p className="field-error" role="alert">{workspaceError}</p> : null}
      </div>
      <Metrics
        status={ENGINE_STATUS[engine.state]}
        contextPercent={usage.percent}
        tokensPerSecond={usage.tokensPerSecond}
        generating={generating}
        tools={agentView ? { used: lastTurn?.stepCount ?? 0, max: lastTurn?.stepLimit ?? STEP_LIMIT } : undefined}
        contextLabel={CP.contextLabel}
        toolLabel={CP.toolLabel}
      />
    </WorkLayout>
  );
}
