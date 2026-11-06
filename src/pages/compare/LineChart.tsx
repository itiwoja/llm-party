import { useEffect, useRef, useState } from "react";
import { PG7, PG7_MISSING } from "./copy";
import { dateText } from "../runs/format";

export interface Point { runId: string; at: string; passRate: number; avgScore: number | null }
export interface Series { presetName: string; points: Point[] }

const HEIGHT = 220;
const PAD = { top: 12, bottom: 24, left: 36, right: 96 };
/** 選んだプリセット以外は色を変えず線の形で見分ける（実線・破線・点線） */
const DASHES = ["", "6 4", "2 4"];
const LABEL_GAP = 14;
/** 端の点が軸や枠に重ならないよう、横に少し余白を取る */
const INSET = 8;

/** CMP-017。凡例は置かず線の端に名前を書く。点に hover で値、読み上げ用に同じ内容の表を持つ */
export function LineChart({ series, focus }: { series: Series[]; focus: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)));
    observer.observe(el);
    setWidth(Math.max(240, el.clientWidth));
    return () => observer.disconnect();
  }, []);

  const times = series.flatMap((s) => s.points.map((p) => new Date(p.at).getTime()));
  const min = Math.min(...times);
  const max = Math.max(...times);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (at: string) => PAD.left + (max === min ? plotW / 2 : INSET + ((new Date(at).getTime() - min) / (max - min)) * (plotW - INSET * 2));
  const y = (rate: number) => PAD.top + (1 - rate) * plotH;
  const line = (s: Series) => s.points.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)} ${y(p.passRate).toFixed(1)}`).join(" ");

  // 端の名前が重なるときは縦にずらす
  const ends = series.map((s, index) => ({ s, index, y: y(s.points.at(-1)!.passRate) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i += 1) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + LABEL_GAP);
  const labelY = new Map(ends.map((e) => [e.index, e.y]));

  const ordered = [...series.keys()].sort((a, b) => Number(series[a].presetName === focus) - Number(series[b].presetName === focus));
  let other = 0;
  const styleOf = new Map(
    series.map((s, i) => [i, s.presetName === focus ? { color: "var(--chart-focus)", dash: "", width: 2.5 } : { color: "var(--chart-other)", dash: DASHES[other++ % DASHES.length], width: 1.5 }]),
  );

  return (
    <div className="chart" ref={box}>
      <svg width={width} height={HEIGHT} role="img" aria-label={PG7.trend} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(tick)} y2={y(tick)} className="chart-grid" />
            <text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end" className="chart-axis numeric">{tick * 100}%</text>
          </g>
        ))}
        <text x={PAD.left} y={HEIGHT - 6} className="chart-axis numeric">{dateText(new Date(min).toISOString())}</text>
        {max !== min ? <text x={PAD.left + plotW} y={HEIGHT - 6} textAnchor="end" className="chart-axis numeric">{dateText(new Date(max).toISOString())}</text> : null}
        {ordered.map((i) => {
          const s = series[i];
          const st = styleOf.get(i)!;
          return (
            <g key={s.presetName}>
              <path d={line(s)} fill="none" stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash || undefined} strokeLinejoin="round" />
              {s.points.map((p) => (
                <circle
                  key={p.runId}
                  cx={x(p.at)}
                  cy={y(p.passRate)}
                  r={4}
                  fill={st.color}
                  className="chart-dot"
                  onMouseEnter={() => setHover({ x: x(p.at), y: y(p.passRate), text: `${s.presetName} ${(p.passRate * 100).toFixed(1)}%` })}
                />
              ))}
              <text
                x={x(s.points.at(-1)!.at) + 10}
                y={(labelY.get(i) ?? 0) + 4}
                className="chart-label"
                fill={s.presetName === focus ? "var(--color-fg)" : "var(--color-muted-fg)"}
              >{s.presetName}</text>
            </g>
          );
        })}
      </svg>
      {hover ? <div className="chart-tip numeric" style={{ left: Math.min(hover.x + 8, width - 140), top: Math.max(0, hover.y - 30) }}>{hover.text}</div> : null}
      <table className="sr-only">
        <caption>{PG7_MISSING.tableTitle}</caption>
        <thead><tr><th scope="col">{PG7_MISSING.date}</th>{series.map((s) => <th key={s.presetName} scope="col">{s.presetName}</th>)}</tr></thead>
        <tbody>
          {series.flatMap((s) => s.points.map((p) => (
            <tr key={p.runId}><th scope="row">{dateText(p.at)}</th>{series.map((o) => <td key={o.presetName}>{o === s ? `${(p.passRate * 100).toFixed(1)}%` : ""}</td>)}</tr>
          )))}
        </tbody>
      </table>
    </div>
  );
}
