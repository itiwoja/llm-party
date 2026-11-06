import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useAppData, useServerEvent } from "../../app-data";
import { errorMessage } from "./format";
import type { DownloadItem } from "./types";

/** 残り時間を出すために、最初に見た時刻とバイト数を覚える */
interface Seen { at: number; bytes: number }

/** DL の一覧と進み（API-056 と download.progress）。完了したらモデルの一覧も読み直す */
export function useDownloads() {
  const { reloadModels } = useAppData();
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const seen = useRef(new Map<string, Seen>());

  const reload = useCallback(async () => {
    try {
      const list = (await api<{ items: DownloadItem[] }>("/downloads")).items;
      setItems(list);
      setError("");
      return list;
    } catch (err) {
      setError(errorMessage(err));
      return [];
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useServerEvent((event) => {
    if (event.event !== "download.progress") return;
    const { downloadId, status, receivedBytes, totalBytes } = event.data as Pick<DownloadItem, "status" | "receivedBytes" | "totalBytes"> & { downloadId: string };
    let known = false;
    setItems((list) => list.map((item) => {
      if (item.id !== downloadId) return item;
      known = true;
      return { ...item, status, receivedBytes, totalBytes };
    }));
    // 新しい DL・完了・失敗は、filePath やエラー文を持つ一覧を取り直す
    if (!known || status === "completed" || status === "failed") void reload();
    if (status === "completed") void reloadModels().catch((err) => setError(errorMessage(err)));
  });

  /** 残り秒。見積もれないときは null */
  const etaSeconds = useCallback((item: DownloadItem): number | null => {
    if (item.status !== "downloading" || !item.totalBytes) return null;
    const now = Date.now();
    const first = seen.current.get(item.id);
    if (!first || item.receivedBytes < first.bytes) {
      seen.current.set(item.id, { at: now, bytes: item.receivedBytes });
      return null;
    }
    const elapsed = (now - first.at) / 1000;
    const rate = (item.receivedBytes - first.bytes) / elapsed;
    if (elapsed < 2 || rate <= 0) return null;
    return (item.totalBytes - item.receivedBytes) / rate;
  }, []);

  return { items, loaded, error, reload, etaSeconds };
}
