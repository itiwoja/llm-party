import type { Db } from "../db";
import { AdapterStore } from "./adapters";
import { AgentStore } from "./agent";
import { ChangeStore } from "./changes";
import { DownloadStore } from "./downloads";
import { EvalStore } from "./eval";
import { ImageStore } from "./images";
import { TrackStore } from "./tracks";
import { ModelStore } from "./models";
import { PresetStore } from "./presets";
import { SettingStore } from "./settings";
import { ThreadStore } from "./threads";

export type { ModelInput } from "./models";
export type { Sampling } from "./presets";
export { now } from "./shared";

/** 分野ごとの保存処理の入口 */
export class Store {
  readonly models: ModelStore;
  readonly adapters: AdapterStore;
  readonly presets: PresetStore;
  readonly threads: ThreadStore;
  readonly agent: AgentStore;
  readonly downloads: DownloadStore;
  readonly changes: ChangeStore;
  readonly evals: EvalStore;
  readonly settings: SettingStore;
  readonly images: ImageStore;
  readonly tracks: TrackStore;

  constructor(db: Db) {
    this.models = new ModelStore(db);
    this.adapters = new AdapterStore(db);
    this.presets = new PresetStore(db, this.models);
    this.threads = new ThreadStore(db);
    this.agent = new AgentStore(db);
    this.downloads = new DownloadStore(db);
    this.changes = new ChangeStore(db);
    this.evals = new EvalStore(db);
    this.settings = new SettingStore(db);
    this.images = new ImageStore(db);
    this.tracks = new TrackStore(db);
  }
}
