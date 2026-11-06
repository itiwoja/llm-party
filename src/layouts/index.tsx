import type { ReactNode } from "react";

/**
 * ページの型（01_ia）。アイコン列と状態の帯は App が出すので、ここは本体の骨組みだけ。
 * 各ページは 1 つ h1 を持つ（見せないなら sr-only）
 */

/** 作業：一覧＋会話（中央 1 列）＋右パネル。panel は第 2 陣が差し込む（null なら出ない） */
export function WorkLayout({ list, panel, children }: { list: ReactNode; panel?: ReactNode; children: ReactNode }) {
  return (
    <div className="page page-work" data-panel={panel ? "open" : undefined}>
      <aside className="list-pane">{list}</aside>
      <main className="work-main">{children}</main>
      {panel ? <aside className="panel">{panel}</aside> : null}
    </div>
  );
}

/** 管理：一覧＋本体（表やフォーム） */
export function ManageLayout({ list, children }: { list?: ReactNode; children: ReactNode }) {
  return (
    <div className={`page page-manage${list ? "" : " no-list"}`}>
      {list ? <aside className="list-pane">{list}</aside> : null}
      <main className="manage-main">{children}</main>
    </div>
  );
}

/** 計測：本体が全幅 */
export function MeasureLayout({ children }: { children: ReactNode }) {
  return (
    <div className="page page-measure">
      <main className="measure-main">{children}</main>
    </div>
  );
}

/** 手順：中央 1 列・ナビなし（PG-002）。App がアイコン列を出さないページで使う */
export function StepLayout({ children }: { children: ReactNode }) {
  return <main className="step-main">{children}</main>;
}
