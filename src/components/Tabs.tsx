import * as RadixTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

export interface TabItem { value: string; label: string; content: ReactNode }

interface Props {
  value: string;
  onValueChange(value: string): void;
  tabs: TabItem[];
  ariaLabel: string;
}

/** CMP-013。矢印キーで移動。切り替えは動かさない */
export function Tabs({ value, onValueChange, tabs, ariaLabel }: Props) {
  return (
    <RadixTabs.Root className="tabs" value={value} onValueChange={onValueChange}>
      <RadixTabs.List className="tabs-list" aria-label={ariaLabel}>
        {tabs.map((tab) => <RadixTabs.Trigger key={tab.value} value={tab.value} className="tab">{tab.label}</RadixTabs.Trigger>)}
      </RadixTabs.List>
      {tabs.map((tab) => <RadixTabs.Content key={tab.value} value={tab.value} className="tabs-content">{tab.content}</RadixTabs.Content>)}
    </RadixTabs.Root>
  );
}
