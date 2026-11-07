import { useEffect } from "react";
import { api } from "../../api";
import { useServerEvent } from "../../app-data";
import { hrefOf, navigate } from "../../router";
import { musicStore } from "./store";

/**
 * 音楽の実行状態を受ける。Shell に常に置き、利用者が別の画面にいる間に届いた下書きや曲の完了も取りこぼさない（D-81）。
 * 画面は持たない
 */
export function MusicRuntime() {
  useEffect(() => {
    void api.get<{ status: "idle" | "drafting" | "composing" | "rendering"; reasoning?: string }>("/music/status")
      .then((status) => musicStore.restore(status))
      .catch(() => undefined);
  }, []);

  useServerEvent((event) => {
    if (event.event !== "music") return;
    const trackId = musicStore.apply(event.data);
    // エディタを見ているときだけ、出来た曲へ移る。別の曲や別の画面にいるなら動かさない
    if (trackId && (location.hash === hrefOf("/music") || location.hash === hrefOf("/music/"))) navigate(`/music/${encodeURIComponent(trackId)}`);
  });

  return null;
}
