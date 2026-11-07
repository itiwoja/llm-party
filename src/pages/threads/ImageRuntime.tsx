import { useEffect } from "react";
import { api } from "../../api";
import { useServerEvent } from "../../app-data";
import { imageStore, type ImageStatus } from "./imageStore";

/** 画像生成の実行状態を受ける。Shell に常に置き、別の画面にいる間の完了や失敗も取りこぼさない（D-84）。画面は持たない */
export function ImageRuntime() {
  useEffect(() => {
    const seq = imageStore.finishedSeq();
    void api.get<ImageStatus>("/images/status")
      .then((status) => imageStore.restore(status, seq))
      .catch(() => undefined);
  }, []);

  useServerEvent((event) => {
    if (event.event === "image") imageStore.apply(event.data);
  });

  return null;
}
