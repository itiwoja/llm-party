import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiRequestError, subscribeEvents, type ServerEvent } from "./api";
import type { EngineStatus, Model, Preset } from "./types";
import type { BandItem } from "./components/StatusBand";
import { pickBand } from "./components/StatusBand";

import { Button } from "./components/Button";
import { CP } from "./copy";

/** server/engine.ts が実行中に落ちたときの error。これだけ CP-017 にする（ほかは起動失敗の CP-016） */
const ENGINE_STOPPED_ERROR = "推論エンジンが停止しました";

type Listener = (event: ServerEvent) => void;

interface AppData {
  presets: Preset[];
  models: Model[];
  /** モデルの一覧が一度届いたか（0 件の判定を読み込み前にしない） */
  modelsLoaded: boolean;
  engine: EngineStatus;
  reloadPresets(): Promise<void>;
  reloadModels(): Promise<void>;
  /** 状態の帯に項目を出す／消す。key ごとに1つ */
  setBand(key: string, item: BandItem | null): void;
  band: BandItem | null;
  /** SSE（API-099）のイベントを受ける。ページごとに 1 本つながず、ここで共有する */
  listen(listener: Listener): () => void;
}

const AppDataContext = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const value = useContext(AppDataContext);
  if (!value) throw new Error("AppDataProvider の外");
  return value;
}

/** SSE のイベントを受ける。handler は毎回の描画で変えてよい */
export function useServerEvent(handler: Listener): void {
  const { listen } = useAppData();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => listen((e) => ref.current(e)), [listen]);
}

/** 状態の帯に項目を出す。null で消える。画面から離れたら自動で消える */
export function useBand(key: string, item: BandItem | null): void {
  const { setBand } = useAppData();
  const message = item?.message;
  const kind = item?.kind;
  const itemRef = useRef(item);
  itemRef.current = item;
  useEffect(() => {
    setBand(key, itemRef.current);
    return () => setBand(key, null);
    // action は描画ごとに作り直されるので、帯の中身は kind と message が変わったときだけ入れ直す
  }, [key, kind, message, setBand]);
}

export function AppDataProvider({ children, onUnauthorized }: { children: ReactNode; onUnauthorized(): void }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [engine, setEngine] = useState<EngineStatus>({ state: "stopped", presetId: null, error: null });
  const [bands, setBands] = useState<Record<string, BandItem>>({});
  const listeners = useRef(new Set<Listener>());

  const reloadPresets = useCallback(async () => setPresets((await api<{ items: Preset[] }>("/presets")).items), []);
  const reloadModels = useCallback(async () => {
    setModels((await api<{ items: Model[] }>("/models")).items);
    setModelsLoaded(true);
  }, []);

  const setBand = useCallback((key: string, item: BandItem | null) => {
    setBands((current) => {
      if (!item && !(key in current)) return current;
      const { [key]: _removed, ...rest } = current;
      return item ? { ...rest, [key]: item } : rest;
    });
  }, []);

  const listen = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  useEffect(() => {
    const unauthorized = (err: unknown) => { if (err instanceof ApiRequestError && err.status === 401) onUnauthorized(); };
    void api<EngineStatus>("/engine").then(setEngine).catch(unauthorized);
    void reloadPresets().catch(unauthorized);
    void reloadModels().catch(unauthorized);
    return subscribeEvents((event) => {
      if (event.event === "engine") setEngine({ state: event.data.state, presetId: event.data.presetId ?? null, error: event.data.error ?? null, installPercent: event.data.installPercent ?? null });
      listeners.current.forEach((l) => l(event));
    });
  }, [onUnauthorized, reloadPresets, reloadModels]);

  // エンジンの状態から出す帯（CP-012, CP-016, CP-017, CP-018）
  const engineBand = useMemo<BandItem | null>(() => {
    if (engine.state === "starting") {
      const name = presets.find((p) => p.id === engine.presetId)?.name ?? "";
      return { kind: "info", busy: true, message: CP.bandLoading(name) };
    }
    if (engine.state === "installing") {
      return { kind: "info", busy: true, message: CP.bandInstalling(engine.installPercent ?? null) };
    }
    if (engine.state === "failed") {
      const presetId = engine.presetId ?? presets[0]?.id;
      return {
        kind: "error",
        message: engine.error === ENGINE_STOPPED_ERROR ? CP.bandEngineStopped : CP.bandLoadFailed,
        detail: engine.error && engine.error !== ENGINE_STOPPED_ERROR ? engine.error : undefined,
        action: presetId ? <Button size="sm" onClick={() => void api.post("/engine/load", { presetId })}>{CP.reload}</Button> : null,
      };
    }
    return null;
  }, [engine, presets]);

  const band = useMemo(() => pickBand([...(engineBand ? [engineBand] : []), ...Object.values(bands)]), [engineBand, bands]);

  const value = useMemo(
    () => ({ presets, models, modelsLoaded, engine, reloadPresets, reloadModels, setBand, band, listen }),
    [presets, models, modelsLoaded, engine, reloadPresets, reloadModels, setBand, band, listen],
  );
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}
