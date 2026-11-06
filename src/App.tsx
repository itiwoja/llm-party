import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiRequestError, subscribeEvents, type ServerEvent } from "./api";
import { getConnection, setToken } from "./platform";

interface Preset { id: string; name: string; contextSize: number }
interface Thread { id: string; title: string }
interface Message { id: string; role: string; content: string; reasoning: string | null }
interface Model { id: string; name: string }

/** FR-014「対話」の値。手元のファイルで始めたときの既定 */
const CHAT_SAMPLING = { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 };

function TokenForm({ onDone }: { onDone(): void }) {
  const [value, setValue] = useState("");
  return (
    <form className="box" onSubmit={(e) => { e.preventDefault(); setToken(value.trim()); onDone(); }}>
      <h1>接続トークン</h1>
      <p>起動時にターミナルに出た URL を開く、またはトークンを貼り付け</p>
      <input value={value} onChange={(e) => setValue(e.target.value)} aria-label="接続トークン" />
      <button type="submit" disabled={!value.trim()}>決定</button>
    </form>
  );
}

function ModelForm({ onDone }: { onDone(): void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const model = await api<Model>("/models", { path: value.trim(), mode: "reference" });
      await api("/presets", { name: model.name, modelId: model.id, sampling: CHAT_SAMPLING, thinking: false, contextSize: 32768 });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form className="box" onSubmit={submit}>
      <h1>ファイルのパス</h1>
      <p>WSL のパスを貼り付け</p>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="/home/…/model.gguf" aria-label="ファイルのパス" />
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={!value.trim()}>決定</button>
    </form>
  );
}

export function App() {
  const [auth, setAuth] = useState<"checking" | "ok" | "needed">("checking");
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [presetId, setPresetId] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [turnId, setTurnId] = useState<string | null>(null);
  const [engine, setEngine] = useState("stopped");
  const [metrics, setMetrics] = useState("");
  const [error, setError] = useState("");

  const threadRef = useRef<string | null>(null);
  threadRef.current = threadId;
  const contextRef = useRef(32768);

  const loadThreads = useCallback(async () => {
    setThreads((await api<{ items: Thread[] }>("/threads")).items);
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    setMessages((await api<{ messages: Message[] }>(`/threads/${id}/messages`)).messages);
  }, []);

  const loadPresets = useCallback(async () => {
    const { items } = await api<{ items: Preset[] }>("/presets");
    setPresets(items);
    setPresetId((current) => current || items[0]?.id || "");
  }, []);

  const start = useCallback(async () => {
    try {
      await api("/health");
      setAuth("ok");
      const status = await api<{ state: string }>("/engine");
      setEngine(status.state);
      await Promise.all([loadPresets(), loadThreads()]);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) setAuth("needed");
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [loadPresets, loadThreads]);

  useEffect(() => {
    if (getConnection().token) void start();
    else setAuth("needed");
  }, [start]);

  useEffect(() => {
    if (auth !== "ok") return;
    return subscribeEvents(({ event, data }: ServerEvent) => {
      if (event === "engine") {
        setEngine(data.state);
        if (data.error) setError(data.error);
      } else if (event === "turn.delta") {
        setMessages((list) => {
          const found = list.some((m) => m.id === data.messageId);
          const base = found ? list : [...list, { id: data.messageId, role: "assistant", content: "", reasoning: null }];
          return base.map((m) => (m.id === data.messageId
            ? { ...m, content: m.content + (data.content ?? ""), reasoning: data.reasoning ? (m.reasoning ?? "") + data.reasoning : m.reasoning }
            : m));
        });
      } else if (event === "turn.usage") {
        const parts: string[] = [];
        if (data.usedTokens !== null) parts.push(`文脈 ${Math.round((data.usedTokens / (data.contextSize || contextRef.current)) * 100)}%`);
        if (data.tokensPerSecond) parts.push(`${data.tokensPerSecond.toFixed(1)} t/s`);
        setMetrics(parts.join("  "));
      } else if (event === "turn.finished") {
        setTurnId(null);
        if (data.error) setError(data.error);
        else if (data.truncated) setError("生成の上限に到達。続きは次の指示で");
        if (threadRef.current) void loadMessages(threadRef.current);
        void loadThreads();
      }
    });
  }, [auth, loadMessages, loadThreads]);

  function newThread() {
    setThreadId(null);
    setMessages([]);
    setMetrics("");
    setError("");
  }

  function openThread(id: string) {
    setThreadId(id);
    setError("");
    void loadMessages(id);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = input.trim();
    if (!content || turnId) return;
    setError("");
    try {
      const id = threadId ?? (await api<Thread>("/threads", { presetId })).id;
      setThreadId(id);
      threadRef.current = id;
      const turn = await api<{ turnId: string }>(`/threads/${id}/turns`, { presetId, content });
      setTurnId(turn.turnId);
      setInput("");
      await loadMessages(id);
      await loadThreads();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (auth === "checking") return null;
  if (auth === "needed") return <TokenForm onDone={() => void start()} />;
  if (presets === null) return null;
  if (presets.length === 0) return <ModelForm onDone={() => void loadPresets()} />;

  return (
    <div className="layout">
      <nav className="threads">
        <button type="button" onClick={newThread}>新規</button>
        {threads.length === 0 && <p>スレッドなし。入力欄から開始</p>}
        <ul>
          {threads.map((t) => (
            <li key={t.id}>
              <button type="button" aria-current={t.id === threadId} onClick={() => openThread(t.id)}>{t.title}</button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="chat">
        <div className="log">
          {messages.map((m) => (
            <article key={m.id} className={m.role}>
              {m.reasoning && <details><summary>思考</summary><pre>{m.reasoning}</pre></details>}
              <div className="content">{m.content}</div>
            </article>
          ))}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <form onSubmit={send}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) void send(e); }}
            placeholder="手元のモデルに指示"
            aria-label="指示"
          />
          {turnId
            ? <button type="button" onClick={() => void api(`/turns/${turnId}/cancel`, {})}>停止</button>
            : <button type="submit" disabled={!input.trim()}>送信</button>}
        </form>
        <p className="metrics">
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)} aria-label="プリセット">
            {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {" "}{engine}  {metrics}
        </p>
      </main>
    </div>
  );
}
