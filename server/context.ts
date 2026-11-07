import { ChatService } from "./chat";
import { openDatabase, type Db } from "./db";
import { EngineManager, type EngineOptions } from "./engine";
import { EvalService } from "./eval/service";
import { EventBus } from "./events";
import { GenerationSlot } from "./generation-slot";
import { DownloadService } from "./hf/downloads";
import { ImageEngine } from "./image-engine";
import { ImageService } from "./images";
import { MusicEngine } from "./music-engine";
import { MusicService } from "./music";
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
  image: ImageEngine;
  images: ImageService;
  music: MusicService;
  /** data/ の場所。API-093・094 などが使う */
  dataDir: string;
  /** HF の接続先。テストで差し替える */
  hfBaseUrl: string;
  close(): Promise<void>;
}

export function createContext({ hfBaseUrl = "https://huggingface.co", commandTimeoutMs, sdBin = null, aceDir = null, ...options }: Omit<EngineOptions, "bus" | "beforeLoad"> & { hfBaseUrl?: string; commandTimeoutMs?: number; sdBin?: string | null; aceDir?: string | null }): Context {
  const db = openDatabase(options.dataDir);
  const bus = new EventBus();
  const store = new Store(db);
  store.models.fillThinkingSupport();
  store.threads.failUnfinishedTurns();
  const slot = new GenerationSlot();
  // 画像生成（sd-server）と推論（llama-server）は同時に1つだけ常駐させる（D-72）
  const image = new ImageEngine({ bin: sdBin, dataDir: options.dataDir, bus });
  const engine = new EngineManager({ ...options, bus, beforeLoad: () => image.stop() });
  const chat = new ChatService(store, engine, bus, slot, { dataDir: options.dataDir, commandTimeoutMs });
  const images = new ImageService(store, engine, image, bus, slot, chat, options.dataDir);
  // 音楽は生成のたびに子プロセスを起動するので常駐しない。始める前にチャットと画像を止める（D-78）
  const music = new MusicService(store, engine, image, new MusicEngine({ dir: aceDir, dataDir: options.dataDir }), bus, slot, chat, options.dataDir);
  const downloads = new DownloadService({ store, bus, dataDir: options.dataDir, hfBaseUrl });
  const evals = new EvalService({ store, engine, bus, slot, dataDir: options.dataDir });
  return {
    db, bus, store, engine, chat, downloads, evals, slot, image, images, music, dataDir: options.dataDir, hfBaseUrl,
    async close() {
      await evals.shutdown();
      await chat.shutdown();
      await images.shutdown();
      await music.shutdown();
      await downloads.shutdown();
      await engine.stop();
      db.close();
    },
  };
}
