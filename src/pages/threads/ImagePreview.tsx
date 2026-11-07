import { useEffect, useState } from "react";
import { getConnection } from "../../platform";
import { PG1 } from "./copy";
import type { ImageProgress } from "./imageStore";

/** 生成の途中経過（D-85）。<img> では認証ヘッダーを付けられないので、fetch で取ってから URL にする */
export function ImagePreview({ progress }: { progress: ImageProgress }) {
  const { step, totalSteps, previewSeq } = progress;
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (previewSeq === 0) return;
    let alive = true;
    const { baseUrl, token } = getConnection();
    fetch(`${baseUrl}/images/preview`, { headers: { Authorization: `Bearer ${token ?? ""}` } })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.blob();
      })
      .then((blob) => {
        if (alive) setSrc(URL.createObjectURL(blob));
      })
      // 途中の画像は表示だけなので、取れなければ前の画像のままにする
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [previewSeq]);

  // 前の URL は次の画像に替わってから捨てる。先に捨てると一瞬消える
  useEffect(() => {
    if (!src) return;
    return () => URL.revokeObjectURL(src);
  }, [src]);

  return (
    <figure className="image-preview">
      {src ? <img src={src} alt={PG1.imagePreview} /> : null}
      <figcaption className="image-message-state status-shimmer" role="status">
        {step !== null && totalSteps !== null ? PG1.imageSteps(step, totalSteps) : PG1.imageGenerating}
      </figcaption>
    </figure>
  );
}
