import { useEffect, useState } from "react";
import { getConnection } from "../../platform";
import { PG1 } from "./copy";

interface ImagePayload {
  imageId: string;
  prompt: string;
  modelName: string;
  width: number;
  height: number;
}

function parsePayload(content: string): ImagePayload | null {
  try {
    const value = JSON.parse(content) as Partial<ImagePayload>;
    return typeof value.imageId === "string" ? (value as ImagePayload) : null;
  } catch {
    return null;
  }
}

/** 生成した画像。<img> では認証ヘッダーを付けられないので、fetch で取ってから URL にする */
export function ImageMessage({ content }: { content: string }) {
  const payload = parsePayload(content);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!payload) return;
    let alive = true;
    let url: string | null = null;
    const { baseUrl, token } = getConnection();
    fetch(`${baseUrl}/images/${encodeURIComponent(payload.imageId)}`, { headers: { Authorization: `Bearer ${token ?? ""}` } })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.blob();
      })
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [payload?.imageId]);

  if (!payload) return <p className="image-message-state">{PG1.imageLoadFailed}</p>;
  return (
    <figure className="image-message">
      {src ? (
        <img src={src} alt={payload.prompt} width={payload.width} height={payload.height} />
      ) : (
        <p className="image-message-state">{failed ? PG1.imageLoadFailed : PG1.imageLoading}</p>
      )}
      <figcaption>{payload.prompt}</figcaption>
    </figure>
  );
}
