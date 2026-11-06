import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/** アプリの根に1つ置く。続けて指すと遅延なし（Radix の skipDelayDuration） */
export const TooltipProvider = RadixTooltip.Provider;

export function Tooltip({ label, side = "right", children }: { label: string; side?: "top" | "right" | "bottom" | "left"; children: ReactNode }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="tooltip" side={side} sideOffset={6}>{label}</RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
