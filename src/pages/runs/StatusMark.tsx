import { Check, Circle, CircleHelp, Loader, Minus, TimerOff, TriangleAlert, X } from "lucide-react";
import { PG6 } from "./copy";

const ICONS: Record<string, { Icon: typeof Check; tone: string; spin?: boolean }> = {
  passed: { Icon: Check, tone: "success" },
  failed: { Icon: X, tone: "danger" },
  needs_review: { Icon: CircleHelp, tone: "warning" },
  timed_out: { Icon: TimerOff, tone: "danger" },
  error: { Icon: TriangleAlert, tone: "danger" },
  running: { Icon: Loader, tone: "muted", spin: true },
  skipped: { Icon: Minus, tone: "muted" },
  pending: { Icon: Circle, tone: "muted" },
};

/** 結果の状態。色だけでなくアイコンと語で伝える（07） */
export function StatusMark({ status }: { status: string }) {
  const { Icon, tone, spin } = ICONS[status] ?? ICONS.pending;
  return <span className={`result-status result-${tone}`}><Icon aria-hidden className={spin ? "spin" : undefined} />{PG6.status[status] ?? status}</span>;
}

