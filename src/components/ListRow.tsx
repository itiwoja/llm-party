import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { ContextMenu, DropdownMenu, type MenuItem } from "./Menu";
import { IconButton } from "./IconButton";

interface Props {
  title: string;
  href: string;
  selected?: boolean;
  /** 行の右に出す状態の点（実行中のスレッドなど） */
  status?: ReactNode;
  menu?: MenuItem[];
  /** … ボタンの名前 */
  menuLabel?: string;
  /** 名前変更中は行の代わりにこれを出す */
  editing?: ReactNode;
}

/** CMP-004。行全体が1つのリンク。右クリックと … で CMP-020 */
export function ListRow({ title, href, selected, status, menu, menuLabel, editing }: Props) {
  if (editing) return <li className="row row-editing">{editing}</li>;
  const row = (
    <li className="row" data-selected={selected || undefined}>
      <a href={href} className="row-link" aria-current={selected ? "page" : undefined}>
        <span className="row-title">{title}</span>
        {status}
      </a>
      {menu && menuLabel ? (
        <DropdownMenu trigger={<IconButton label={menuLabel} className="row-more"><Ellipsis aria-hidden /></IconButton>} menu={menu} />
      ) : null}
    </li>
  );
  return menu ? <ContextMenu menu={menu}>{row}</ContextMenu> : row;
}
