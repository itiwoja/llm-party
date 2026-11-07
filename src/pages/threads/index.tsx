import { ArrowUp, Folder, PanelRight, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiRequestError } from "../../api";
import { useAppData, useBand, useServerEvent } from "../../app-data";
import { Button } from "../../components/Button";
import { ComposerInput } from "../../components/ComposerInput";
import { SelectField } from "../../components/Controls";
import { IconButton } from "../../components/IconButton";
import { Metrics } from "../../components/Metrics";
import { Collapsible } from "../../components/Collapsible";
import { CP, MISSING_COPY } from "../../copy";
import { WorkLayout } from "../../layouts";
import { navigate, useRoute } from "../../router";
import { pickFolder } from "../../platform";
import { thinkingChoice, thinkingOptions, thinkingPatch } from "../../thinking";
import type { EngineState } from "../../types";
import { Conversation } from "./Conversation";
import { INSTRUMENTAL, MUSIC_DEFAULT_SECONDS, MusicOptions } from "./MusicOptions";
import { PG1, MISSING } from "./copy";
import { Panel, TERMINAL_MAX_CHARS } from "./Panel";
import { ThreadList } from "./ThreadList";
import type { Decide } from "./ToolCard";
import type { FileChange, ThreadInfo, ThreadMessage, ToolCall, TurnInfo, Workspace } from "./types";
import "./threads.css";

const ENGINE_STATUS: Record<EngineState, { tone: "ok" | "busy" | "error" | "idle"; label: string }> = {
  ready: { tone: "ok", label: MISSING_COPY.engineReady },
  starting: { tone: "busy", label: MISSING_COPY.engineStarting },
  installing: { tone: "busy", label: MISSING_COPY.engineInstalling },
  stopped: { tone: "idle", label: MISSING_COPY.engineStopped },
  failed: { tone: "error", label: MISSING_COPY.engineFailed },
};

/** D-24：1 指示のツール呼び出しの上限（まだターンがないときの表示用） */
const STEP_LIMIT = 40;
/** 左の一覧はプロジェクトごとに分けるので、API の上限（200）まで読む */
const THREAD_LIST_LIMIT = 200;
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
  /** 新しいスレッドの入力画面で選んでいるプロジェクト */
  const projectId = route.page === "threads" ? route.projectId : undefined;
  const { presets, models, engine, reloadPresets } = useAppData();

  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [projects, setProjects] = useState<Workspace[]>([]);
  const [presetId, setPresetId] = useState("");
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [turns, setTurns] = useState<TurnInfo[]>([]);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [live, setLive] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  // 動いているターン（同時に2本まで）。表示中のスレッドのものが turn
  const [running, setRunning] = useState<{ id: string; threadId: string }[]>([]);
  const turn = running.find((r) => r.threadId === threadId) ?? null;
  const [stepWait, setStepWait] = useState(false);
  const [usage, setUsage] = useState<Usage>({ percent: null, tokensPerSecond: null });
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [looped, setLooped] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState("diff");
  const [evalProgress, setEvalProgress] = useState<{ done: number; total: number } | null>(null);
  /** 画像モード：モデルの選択で画像モデルを選んだとき。入力を画像の生成に回す（D-72） */
  const [imageMode, setImageMode] = useState(false);
  const [imageModelId, setImageModelId] = useState("");
  const imageModels = useMemo(() => models.filter((m) => m.use === "image"), [models]);
  /** 音楽モード：音楽モデルを選んだとき。入力を曲の説明として生成に回す（D-78）。画像モードとは同時に立たない */
  const [musicMode, setMusicMode] = useState(false);
  const [musicModelId, setMusicModelId] = useState("");
  const musicModels = useMemo(() => models.filter((m) => m.use === "music"), [models]);
  const [musicDuration, setMusicDuration] = useState(MUSIC_DEFAULT_SECONDS);
  const [musicInstrumental, setMusicInstrumental] = useState(false);
  const [musicLyrics, setMusicLyrics] = useState("");
  /** チャットのプリセットと画像モデルを1か所で選ぶ。値は種類:id */
  const modelOptions = useMemo(
    () => [
      ...presets.map((p) => ({ value: `preset:${p.id}`, label: p.name, group: PG1.chatGroup })),
      ...imageModels.map((m) => ({ value: `image:${m.id}`, label: m.name, group: PG1.imageGroup })),
      ...musicModels.map((m) => ({ value: `music:${m.id}`, label: m.name, group: PG1.musicGroup })),
    ],
    [presets, imageModels, musicModels],
  );
  const modelChoice = musicMode ? `music:${musicModelId}` : imageMode ? `image:${imageModelId}` : `preset:${presetId}`;
  /** 選んでいるプリセットのモデルで変えられる思考の選択肢（D-76）。無ければ欄を出さない */
  const preset = presets.find((p) => p.id === presetId);
  const presetModel = models.find((m) => m.id === preset?.modelId);
  const thinkingChoices = imageMode || musicMode ? [] : thinkingOptions(presetModel);
  const [imageBusy, setImageBusy] = useState(false);
  // 生成中の依頼。文は生成が終わるまで DB に入らないので、画面には送った時点でこれを出す
  const [pendingImage, setPendingImage] = useState<{ threadId: string; prompt: string } | null>(null);
  // 画像生成中の表示文。進捗の数字は画面に出さない（"image" の progress は無視する）
  const [musicPhase, setMusicPhase] = useState<"composing" | "rendering">("composing");
  const [musicRunning, setMusicRunning] = useState(false);
  const [musicThought, setMusicThought] = useState("");
  const imageNote = musicRunning ? (musicPhase === "rendering" ? PG1.musicRendering : PG1.musicComposing) : PG1.imageGenerating;

  const composer = useRef<HTMLTextAreaElement>(null);
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  const toolCallsRef = useRef(toolCalls);
  toolCallsRef.current = toolCalls;
  const listSeq = useRef(0);

  const thread = threads.find((t) => t.id === threadId);
  const isAgent = Boolean(thread?.workspaceId);
  const project = projects.find((p) => p.id === projectId);
  const pendingCalls = useMemo(() => toolCalls.filter((c) => c.status === "pending_approval"), [toolCalls]);

  useBand("truncated", truncated ? { kind: "warning", message: CP.truncated } : null);
  useBand("looped", looped ? { kind: "warning", message: CP.looped } : null);
  useBand("approval", pendingCalls.length > 0 ? { kind: "warning", message: PG1.bandApproval(pendingCalls.length) } : null);
  useBand("eval", evalProgress ? { kind: "info", busy: true, message: PG1.bandEval(evalProgress.done, evalProgress.total) } : null);

  const loadThreads = useCallback(async () => {
    const seq = ++listSeq.current;
    const { items } = await api<{ items: ThreadInfo[] }>(`/threads?limit=${THREAD_LIST_LIMIT}`);
    if (seq === listSeq.current) setThreads(items);
  }, []);

  const loadProjects = useCallback(async () => {
    const { items } = await api<{ items: Workspace[] }>("/workspaces");
    setProjects(items);
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
    const activeNow = last && ACTIVE_TURN.includes(last.status) ? last : null;
    setRunning((list) => [...list.filter((r) => r.threadId !== id), ...(activeNow ? [{ id: activeNow.id, threadId: id }] : [])]);
    if (activeNow) setStepWait(activeNow.status === "step_limit");
    else if (turnRef.current?.threadId === id) setStepWait(false);
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

  useEffect(() => { void loadThreads().catch(() => undefined); }, [loadThreads]);
  useEffect(() => { void loadProjects().catch(() => undefined); }, [loadProjects]);

  // プリセットは初期値として先頭。スレッドを開いたら最後に使ったものへ、プロジェクトの新規ならその既定へ
  // 中身の更新（思考の変更）で選び直さないよう、見るのは id の顔ぶれだけ
  const presetIds = presets.map((p) => p.id).join();
  useEffect(() => {
    setPresetId((current) => {
      const last = threads.find((t) => t.id === threadId)?.lastPresetId ?? (threadId ? null : project?.defaultPresetId);
      if (last && presets.some((p) => p.id === last)) return last;
      return presets.some((p) => p.id === current) ? current : presets[0]?.id ?? "";
    });
    // threads は一覧の更新ごとに変わるので、開いたスレッドが変わったときとプリセットが届いたときだけ見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, presetIds, project?.defaultPresetId]);

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
    setWorkspaceError("");
    setPanelOpen(false);
    if (threadId) {
      void loadDetail(threadId).catch((err) => setError(errorText(err)));
      void loadChanges(threadId);
    }
    composer.current?.focus();
  }, [threadId, loadDetail, loadChanges]);

  useEffect(() => { composer.current?.focus(); }, [projectId]);

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
    // 終わったターンは、どのスレッドのものでも一覧から外す
    if (event === "turn.finished") setRunning((list) => list.filter((r) => r.id !== data.turnId));
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
    } else if (event === "image" && data.status === "progress") {
      // 進捗は画面に表示しない
    } else if (event === "image") {
      setImageBusy(false);
      setPendingImage(null);
      if (data.status === "failed") setError(data.error);
      else if (threadRef.current === data.threadId) void loadDetail(data.threadId).catch(() => undefined);
      void loadThreads().catch(() => undefined);
    } else if (event === "music" && data.status === "progress") {
      setMusicPhase(data.phase);
      if (data.reasoning) setMusicThought(data.reasoning);
    } else if (event === "music") {
      setImageBusy(false);
      setMusicRunning(false);
      setPendingImage(null);
      if (data.status === "failed") setError(data.error);
      else if (threadRef.current === data.threadId) void loadDetail(data.threadId).catch(() => undefined);
      void loadThreads().catch(() => undefined);
    } else if (event === "eval.progress") {
      setEvalProgress({ done: data.done, total: data.total });
    } else if (event === "eval.finished") {
      setEvalProgress(null);
    }
  });

  // 画像モデルが変わったら、選んでいる画像モデルを確かめる。1 つも無くなったらチャットへ戻す
  useEffect(() => {
    setImageModelId((current) => (imageModels.some((m) => m.id === current) ? current : imageModels[0]?.id ?? ""));
    if (imageModels.length === 0) setImageMode(false);
  }, [imageModels]);

  useEffect(() => {
    setMusicModelId((current) => (musicModels.some((m) => m.id === current) ? current : musicModels[0]?.id ?? ""));
    if (musicModels.length === 0) setMusicMode(false);
  }, [musicModels]);

  /** 1 か所の選択。画像モデルなら画像モード、プリセットならチャット（presetId は常に持つ。スレッドの作成に要る） */
  function chooseModel(value: string) {
    const [kind, ...rest] = value.split(":");
    const id = rest.join(":");
    setImageMode(kind === "image");
    setMusicMode(kind === "music");
    if (kind === "image") setImageModelId(id);
    else if (kind === "music") setMusicModelId(id);
    else setPresetId(id);
  }

  /** プリセットごとに覚える（API-062）。次の送信から効く */
  function chooseThinking(value: string) {
    void api.patch(`/presets/${presetId}`, thinkingPatch(value)).then(reloadPresets).catch((err) => setError(errorText(err)));
  }

  async function send() {
    const content = input.trim();
    if (!content || turn || imageBusy || !presetId || (imageMode && !imageModelId) || (musicMode && !musicModelId)) return;
    setError("");
    setTruncated(false);
    setLooped(false);
    try {
      const id = threadId ?? (await api<ThreadInfo>("/threads", { presetId, ...(projectId ? { workspaceId: projectId } : {}) })).id;
      threadRef.current = id;
      if (imageMode || musicMode) {
        setImageBusy(true);
        setPendingImage({ threadId: id, prompt: content });
        if (musicMode) {
          setMusicRunning(true);
          setMusicPhase("composing");
          setMusicThought("");
        }
        try {
          if (musicMode) {
            await api(`/threads/${id}/music`, {
              modelId: musicModelId, prompt: content, duration: musicDuration,
              lyrics: musicInstrumental ? INSTRUMENTAL : musicLyrics,
            });
          } else {
            await api(`/threads/${id}/images`, { modelId: imageModelId, prompt: content });
          }
        } catch (err) {
          setImageBusy(false);
          setMusicRunning(false);
          setPendingImage(null);
          throw err;
        }
        setInput("");
        if (id !== threadId) navigate(`/threads/${id}`, true);
        await loadDetail(id);
        await loadThreads();
        return;
      }
      const started = await api<{ turnId: string }>(`/threads/${id}/turns`, { presetId, content });
      setRunning((list) => [...list.filter((r) => r.threadId !== id), { id: started.turnId, threadId: id }]);
      setInput("");
      if (id !== threadId) navigate(`/threads/${id}`, true);
      await loadDetail(id);
      await loadThreads();
    } catch (err) {
      setError(errorText(err));
    }
  }

  /** フォルダを選んでプロジェクトにし、そのプロジェクトの入力画面へ */
  async function addProject() {
    setWorkspaceError("");
    const path = await pickFolder();
    if (!path) return;
    try {
      const added = await api<Workspace>("/workspaces", { path });
      await Promise.all([loadProjects(), loadThreads()]);
      navigate(`/threads/new/${added.id}`);
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

  /** 画像生成を止める。届くのは "image" イベント（cancelled）で、画面の後始末はそこで行う */
  async function stopImage() {
    const id = threadRef.current;
    if (!id) return;
    await api.post(`/threads/${id}/${musicRunning ? "music" : "images"}/cancel`).catch((err) => setError(errorText(err)));
  }

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
  const runningIds = new Set(running.map((r) => r.threadId));
  const lastTurn = turns.at(-1);
  const contextFull = !generating && lastTurn?.status === "failed" && lastTurn.error === PG1.contextFull;
  const turnError = !generating && lastTurn?.status === "failed" && lastTurn.error && !contextFull ? lastTurn.error : "";
  const agentView = isAgent || projectId !== undefined;
  const workspaceName = thread?.workspaceName ?? project?.name;
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
          projects={projects}
          selectedId={threadId}
          projectId={projectId}
          runningIds={runningIds}
          onChanged={() => void loadThreads()}
          onAddProject={() => void addProject()}
          onProjectsChanged={() => { void loadProjects(); void loadThreads(); }}
        />
      }
      panel={panel}
    >
      <h1 className="sr-only">{CP.nav.threads}</h1>
      {isAgent && !panelOpen ? (
        <header className="thread-head">
          <IconButton label={MISSING.openPanel} className="head-panel" onClick={() => setPanelOpen(true)}><PanelRight aria-hidden /></IconButton>
        </header>
      ) : null}
      <Conversation
        messages={messages}
        toolCalls={toolCalls}
        error={error || turnError}
        onDecide={decide}
        footer={<>
          {pendingImage && pendingImage.threadId === threadId ? (
            <>
              <article className="message message-user"><div className="user-text">{pendingImage.prompt}</div></article>
              {musicRunning && musicThought ? <Collapsible summary={CP.thinking}><div className="reasoning">{musicThought}</div></Collapsible> : null}
              <p className="image-message-state status-shimmer" role="status">{imageNote}</p>
            </>
          ) : null}
          {generating && stepWait ? (
            <div className="step-limit" role="group" aria-label={PG1.stepLimit}>
              <p>{PG1.stepLimit}</p>
              <div className="approval-actions">
                <Button variant="primary" size="sm" onClick={() => void answerStepLimit("continue")}>{PG1.continue}</Button>
                <Button size="sm" onClick={() => void answerStepLimit("stop")}>{PG1.stop}</Button>
              </div>
            </div>
          ) : null}
        </>}
      />
      {contextFull ? (
        <div className="context-full" role="alert">
          <p className="field-error">{PG1.contextFull}</p>
          <Button size="sm" onClick={() => void continueInNewThread()}>{PG1.continueInNew}</Button>
        </div>
      ) : null}
      {workspaceError ? <p className="field-error workspace-error" role="alert">{workspaceError}</p> : null}
      <form className="composer-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <ComposerInput
          ref={composer}
          id="composer"
          label={CP.instruction}
          placeholder={musicMode ? PG1.musicPlaceholder : CP.instructionPlaceholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onSubmit={() => void send()}
        />
        {musicMode && !imageBusy ? (
          <MusicOptions
            duration={musicDuration}
            instrumental={musicInstrumental}
            lyrics={musicLyrics}
            onDuration={setMusicDuration}
            onInstrumental={setMusicInstrumental}
            onLyrics={setMusicLyrics}
          />
        ) : null}
        <div className="composer-foot">
          <div className="composer-info">
            {workspaceName ? (
              <span className="workspace-name" title={PG1.workspace(workspaceName)}>
                {threadId ? <Folder aria-hidden /> : null}
                <span className="sr-only">{PG1.workspace("")}</span>
                <span className="workspace-text">{workspaceName}</span>
              </span>
            ) : null}
            <Metrics
              status={ENGINE_STATUS[engine.state]}
              contextPercent={usage.percent}
              tokensPerSecond={usage.tokensPerSecond}
              generating={generating}
              tools={agentView ? { used: lastTurn?.stepCount ?? 0, max: lastTurn?.stepLimit ?? STEP_LIMIT } : undefined}
              contextLabel={CP.contextLabel}
              toolLabel={CP.toolLabel}
            />
          </div>
          <div className="composer-model">
            {imageBusy ? <span className="composer-note" role="status">{imageNote}</span> : null}
            {contextSize && !imageMode && !musicMode ? <span className="numeric head-context">{Math.round(contextSize / 1024)}K</span> : null}
            <SelectField
              compact
              hideLabel
              label={PG1.modelSelect}
              value={modelChoice}
              onValueChange={chooseModel}
              options={modelOptions}
              disabled={generating || imageBusy}
            />
            {preset && presetModel && thinkingChoices.length > 0 ? (
              <SelectField
                compact
                hideLabel
                label={CP.thinkingSelect}
                value={thinkingChoice(presetModel, preset)}
                onValueChange={chooseThinking}
                options={thinkingChoices}
                disabled={generating || imageBusy}
              />
            ) : null}
            {generating ? (
              <IconButton className="composer-stop" label={CP.stop} disabled={stepWait} onClick={() => turn && void api.post(`/turns/${turn.id}/cancel`).catch((err) => setError(errorText(err)))}>
                <Square aria-hidden />
              </IconButton>
            ) : imageBusy ? (
              <IconButton className="composer-stop" label={CP.stop} onClick={() => void stopImage()}>
                <Square aria-hidden />
              </IconButton>
            ) : (
              <IconButton className="composer-send" type="submit" label={CP.send} disabled={!input.trim() || !presetId || turn !== null || (imageMode && !imageModelId) || (musicMode && !musicModelId)}>
                <ArrowUp aria-hidden />
              </IconButton>
            )}
          </div>
        </div>
      </form>
    </WorkLayout>
  );
}
