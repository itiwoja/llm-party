import { Search, X } from "lucide-react";
import { IconButton } from "./IconButton";

interface Props {
  value: string;
  onChange(value: string): void;
  /** CP-029 / CP-091。aria-label とプレースホルダーの両方に使う */
  label: string;
  /** 入力中に出す消去ボタンの名前 */
  clearLabel: string;
}

/** CMP-003 */
export function SearchField({ value, onChange, label, clearLabel }: Props) {
  return (
    <div className="search">
      <Search aria-hidden className="search-icon" />
      <input type="search" className="search-input" value={value} placeholder={label} aria-label={label} onChange={(e) => onChange(e.target.value)} />
      {value ? <IconButton label={clearLabel} className="search-clear" onClick={() => onChange("")}><X aria-hidden /></IconButton> : null}
    </div>
  );
}
