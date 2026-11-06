import { useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

interface Props {
  label: string;
  /** null なら —。変わると前の値から数え上げる（MOT-004） */
  value: number | null;
  format(value: number): string;
  /** 大きい数字（正解率）か、見出しの大きさか（05 の段の付け方） */
  large?: boolean;
  /** 差（+15.0）。上がれば success＋↗、下がれば danger＋↘ */
  delta?: { value: number; format(value: number): string } | null;
}

/** MOT-004。--duration-slow と同じ 280ms。reduced-motion のときは即時 */
const COUNT_MS = 280;

function useCountUp(target: number | null): number | null {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = from.current;
    if (target === null || start === null || reduce || start === target) {
      from.current = target;
      setShown(target);
      return;
    }
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / COUNT_MS);
      const eased = 1 - (1 - t) ** 3;
      const value = start + (target - start) * eased;
      from.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

/** CMP-016。押せない。数え上げの途中は読み上げず、確定した値だけ読む */
export function Metric({ label, value, format, large, delta }: Props) {
  const shown = useCountUp(value);
  const text = value === null ? "—" : format(value);
  return (
    <div className={`metric${large ? " metric-large" : ""}`}>
      <span className="metric-value numeric" aria-hidden>{shown === null ? "—" : format(shown)}</span>
      <span className="sr-only">{text}</span>
      {delta ? (
        <span className={`metric-delta numeric ${delta.value > 0 ? "metric-up" : delta.value < 0 ? "metric-down" : ""}`}>
          {delta.value > 0 ? <ArrowUpRight aria-hidden /> : delta.value < 0 ? <ArrowDownRight aria-hidden /> : null}
          {delta.value > 0 ? "+" : delta.value < 0 ? "−" : ""}{delta.format(delta.value)}
        </span>
      ) : null}
      <span className="metric-label">{label}</span>
    </div>
  );
}
