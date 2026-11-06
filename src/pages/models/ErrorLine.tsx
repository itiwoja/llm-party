import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** 欄の外に出すエラー（CMP-005 のエラーと同じ見た目）。原因と直し方の2文は呼ぶ側が渡す */
export function ErrorLine({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <p className="field-error" role="alert">
      <CircleAlert aria-hidden />
      <span>{message}{children}</span>
    </p>
  );
}
