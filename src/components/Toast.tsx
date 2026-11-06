import * as RadixToast from "@radix-ui/react-toast";
import { MISSING_COPY } from "../copy";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/** 完了の知らせは 4 秒で消える（CMP-021）。エラーはトーストにしない */
const DURATION_MS = 4000;

interface ToastItem { id: number; message: string }
const ToastContext = createContext<(message: string) => void>(() => undefined);

/** `const toast = useToast(); toast("保存済み")`（CP-019 など） */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const show = useCallback((message: string) => setItems((list) => [...list, { id: Date.now() + Math.random(), message }]), []);
  return (
    <ToastContext.Provider value={show}>
      <RadixToast.Provider duration={DURATION_MS} label={MISSING_COPY.toastRegion}>
        {children}
        {items.map((item) => (
          <RadixToast.Root key={item.id} className="toast" onOpenChange={(open) => { if (!open) setItems((list) => list.filter((t) => t.id !== item.id)); }}>
            <RadixToast.Description>{item.message}</RadixToast.Description>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="toast-viewport" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}
