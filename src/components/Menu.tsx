import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as Context from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";

export interface MenuItem {
  label: string;
  onSelect(): void;
  /** 削除などは danger の文字 */
  danger?: boolean;
}

function items(list: MenuItem[], Item: typeof Dropdown.Item | typeof Context.Item) {
  return list.map((item) => (
    <Item key={item.label} className={`menu-item${item.danger ? " menu-item-danger" : ""}`} onSelect={item.onSelect}>{item.label}</Item>
  ));
}

/** CMP-020。ボタンから開く形（… ボタンなど）。trigger は押せる要素 1 つ */
export function DropdownMenu({ trigger, menu }: { trigger: ReactNode; menu: MenuItem[] }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu" align="end" sideOffset={4}>{items(menu, Dropdown.Item)}</Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** CMP-020。右クリックで開く形。children を包む */
export function ContextMenu({ menu, children }: { menu: MenuItem[]; children: ReactNode }) {
  return (
    <Context.Root>
      <Context.Trigger asChild>{children}</Context.Trigger>
      <Context.Portal>
        <Context.Content className="menu">{items(menu, Context.Item)}</Context.Content>
      </Context.Portal>
    </Context.Root>
  );
}
