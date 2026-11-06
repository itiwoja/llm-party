/** 時間（FR-018 の合計時間）。ケースは 42s、合計は 12:05 */
export function secondsText(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms / 1000)}s`;
}

export function clockText(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export const percentText = (rate: number | null) => (rate === null ? "—" : `${(rate * 100).toFixed(1)}%`);
export const scoreText = (score: number | null) => (score === null ? "—" : score.toFixed(1));
export const speedText = (speed: number | null) => (speed === null ? "—" : speed.toFixed(1));

/** 日時は「月/日 時:分」。同じ日のランを区別できれば足りる */
export function dateText(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
