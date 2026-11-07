import { useEffect, useState } from "react";
import { Collapsible } from "../../components/Collapsible";
import { getConnection } from "../../platform";
import { CP } from "../../copy";
import { PG1 } from "./copy";

interface MusicPayload {
  trackId: string;
  prompt: string;
  lyrics: string;
  /** 古い曲には無い */
  reasoning?: string;
  modelName: string;
  duration: number;
  bpm: number | null;
  keyscale: string | null;
}

function parsePayload(content: string): MusicPayload | null {
  try {
    const value = JSON.parse(content) as Partial<MusicPayload>;
    return typeof value.trackId === "string" ? (value as MusicPayload) : null;
  } catch {
    return null;
  }
}

/** 生成した曲。<audio> では認証ヘッダーを付けられないので、fetch で取ってから URL にする */
export function MusicMessage({ content }: { content: string }) {
  const payload = parsePayload(content);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!payload) return;
    let alive = true;
    let url: string | null = null;
    const { baseUrl, token } = getConnection();
    fetch(`${baseUrl}/music/${encodeURIComponent(payload.trackId)}`, { headers: { Authorization: `Bearer ${token ?? ""}` } })
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
  }, [payload?.trackId]);

  if (!payload) return <p className="image-message-state">{PG1.musicLoadFailed}</p>;
  const facts = [`${payload.duration} 秒`, payload.bpm ? `${payload.bpm} BPM` : null, payload.keyscale].filter(Boolean).join(" ・ ");
  const hasLyrics = payload.lyrics && payload.lyrics !== "[Instrumental]";
  return (
    <figure className="music-message">
      {payload.reasoning ? <Collapsible summary={CP.thinking}><div className="reasoning">{payload.reasoning}</div></Collapsible> : null}
      {src ? (
        <audio controls src={src} aria-label={payload.prompt} />
      ) : (
        <p className="image-message-state">{failed ? PG1.musicLoadFailed : PG1.musicLoading}</p>
      )}
      <figcaption>
        {payload.prompt}
        <span className="music-facts numeric">{facts}</span>
      </figcaption>
      {hasLyrics ? <Collapsible summary={PG1.musicLyrics}><div className="music-lyrics-text">{payload.lyrics}</div></Collapsible> : null}
    </figure>
  );
}
