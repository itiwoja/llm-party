import { CircleAlert, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

export type BandKind = "info" | "warning" | "error";
export interface BandItem {
  kind: BandKind;
  message: string;
  /** 原因の補足（サーバーが返した文）。文言の正本ではない */
  detail?: string;
  /** 右に置くボタン（再読み込みなど） */
  action?: ReactNode;
  /** info のとき、読み込み中のスピナーにする */
  busy?: boolean;
}

const ORDER: BandKind[] = ["error", "warning", "info"];

/** 複数あるときはエラー → 警告 → 情報の順で1本にする */
export function pickBand(items: BandItem[]): BandItem | null {
  for (const kind of ORDER) {
    const found = items.find((i) => i.kind === kind);
    if (found) return found;
  }
  return null;
}

/** CMP-009。何もないときは出さない（高さも取らない）。背景は surface、文字だけ状態色 */
export function StatusBand({ item }: { item: BandItem | null }) {
  if (!item) return null;
  const Icon = item.kind === "error" ? CircleAlert : item.kind === "warning" ? TriangleAlert : item.busy ? LoaderCircle : Info;
  return (
    <div className={`band band-${item.kind}`} role={item.kind === "error" ? "alert" : "status"} aria-live={item.kind === "error" ? "assertive" : "polite"}>
      <Icon aria-hidden className={item.busy ? "spin" : undefined} />
      <span className="band-text">{item.message}{item.detail ? <span className="band-detail">{item.detail}</span> : null}</span>
      {item.action}
    </div>
  );
}
