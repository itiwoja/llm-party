import { ChatService } from "./chat";
import { openDatabase, type Db } from "./db";
import { EngineManager, type EngineOptions } from "./engine";
import { EvalService } from "./eval/service";
import { EventBus } from "./events";
import { GenerationSlot } from "./generation-slot";
import { DownloadService } from "./hf/downloads";
import { Store } from "./store";

export interface Context {
  db: Db;
  bus: EventBus;
  store: Store;
  engine: EngineManager;
  chat: ChatService;
  downloads: DownloadService;
  evals: EvalService;
  slot: GenerationSlot;
  /** data/ の場所。API-093・094 などが使う */
  dataDir: string;
  /** HF の接続先。テストで差し替える */
  hfBaseUrl: string;
  close(): Promise<void>;
}

export function createContext({ hfBaseUrl = "https://huggingface.co", commandTimeoutMs, ...options }: Omit<EngineOptions, "bus"> & { hfBaseUrl?: string; commandTimeoutMs?: number }): Context {
  const db = openDatabase(options.dataDir);
  const bus = new EventBus();
  const store = new Store(db);
  store.threads.failUnfinishedTurns();
  const engine = new EngineManager({ ...options, bus });
  const slot = new GenerationSlot();
  const chat = new ChatService(store, engine, bus, slot, { dataDir: options.dataDir, commandTimeoutMs });
  const downloads = new DownloadService({ store, bus, dataDir: options.dataDir, hfBaseUrl });
  const evals = new EvalService({ store, engine, bus, slot, dataDir: options.dataDir });
  return {
    db, bus, store, engine, chat, downloads, evals, slot, dataDir: options.dataDir, hfBaseUrl,
    async close() {
      await evals.shutdown();
      await chat.shutdown();
      await downloads.shutdown();
      await engine.stop();
      db.close();
    },
  };
}
