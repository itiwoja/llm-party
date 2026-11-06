import { useState, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  render(row: T): ReactNode;
  /** 数字の列は右揃え・等幅 */
  numeric?: boolean;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey(row: T): string;
  /** 渡すと行全体が押せる表になり、hover が付く */
  onRowClick?(row: T): void;
  caption: string;
  /** 行がないときの文言 */
  empty?: string;
}

/** 50 行を超えたら表示中の分だけ描く（07）。行の高さは --row-height で固定 */
const WINDOW_THRESHOLD = 50;
const ROW_HEIGHT = 36;
const VIEWPORT_ROWS = 20;
const OVERSCAN = 5;

/** CMP-014 */
export function Table<T>({ columns, rows, rowKey, onRowClick, caption, empty }: Props<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const windowed = rows.length > WINDOW_THRESHOLD;
  const first = windowed ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const last = windowed ? Math.min(rows.length, first + VIEWPORT_ROWS + OVERSCAN * 2) : rows.length;
  const shown = rows.slice(first, last);

  if (rows.length === 0 && empty) return <p className="empty">{empty}</p>;
  return (
    <div className="table-scroll" style={windowed ? { maxHeight: ROW_HEIGHT * (VIEWPORT_ROWS + 1) } : undefined} onScroll={windowed ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}>
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} scope="col" className={c.numeric ? "numeric num-col" : undefined}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {windowed && first > 0 ? <tr aria-hidden style={{ height: first * ROW_HEIGHT }} /> : null}
          {shown.map((row) => (
            <tr key={rowKey(row)} className={onRowClick ? "clickable" : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((c) => <td key={c.key} className={c.numeric ? "numeric num-col" : undefined}>{c.render(row)}</td>)}
            </tr>
          ))}
          {windowed && last < rows.length ? <tr aria-hidden style={{ height: (rows.length - last) * ROW_HEIGHT }} /> : null}
        </tbody>
      </table>
    </div>
  );
}
