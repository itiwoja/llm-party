import { useEffect, useState } from "react";
import { getConnection } from "../../platform";

interface TrackAudio { src: string | null; loading: boolean; failed: boolean; notFound: boolean }

/** <audio> では認証ヘッダーを付けられないので、fetch で取ってから URL にする */
export function useTrackAudio(trackId: string | null): TrackAudio {
  const [result, setResult] = useState<{ id: string; src: string | null; notFound: boolean } | null>(null);

  useEffect(() => {
    if (!trackId) return;
    let alive = true;
    let url: string | null = null;
    const { baseUrl, token } = getConnection();
    fetch(`${baseUrl}/music/${encodeURIComponent(trackId)}`, { headers: { Authorization: `Bearer ${token ?? ""}` } })
      .then(async (res): Promise<{ blob: Blob | null; notFound: boolean }> => {
        if (res.status === 404) return { blob: null, notFound: true };
        if (!res.ok) throw new Error(String(res.status));
        return { blob: await res.blob(), notFound: false };
      })
      .then(({ blob, notFound }) => {
        if (!alive) return;
        url = blob ? URL.createObjectURL(blob) : null;
        setResult({ id: trackId, src: url, notFound });
      })
      .catch(() => {
        if (alive) setResult({ id: trackId, src: null, notFound: false });
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [trackId]);

  // 前の曲の結果は使わない（id が合うものだけ）
  const current = trackId && result?.id === trackId ? result : null;
  return { src: current?.src ?? null, loading: !!trackId && !current, failed: !!current && !current.src, notFound: !!current?.notFound };
}
