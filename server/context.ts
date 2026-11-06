import { ChatService } from "./chat";
import { openDatabase, type Db } from "./db";
import { EngineManager, type EngineOptions } from "./engine";
import { EventBus } from "./events";
import { Store } from "./store";

export interface Context {
  db: Db;
  bus: EventBus;
  store: Store;
  engine: EngineManager;
  chat: ChatService;
  close(): Promise<void>;
}

export function createContext(options: Omit<EngineOptions, "bus">): Context {
  const db = openDatabase(options.dataDir);
  const bus = new EventBus();
  const store = new Store(db);
  store.failUnfinishedTurns();
  const engine = new EngineManager({ ...options, bus });
  const chat = new ChatService(store, engine, bus);
  return {
    db, bus, store, engine, chat,
    async close() {
      await chat.shutdown();
      await engine.stop();
      db.close();
    },
  };
}
