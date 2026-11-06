import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "./Tooltip";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** アイコンだけのボタンは必ず名前を付ける（aria-label とツールチップ） */
  label: string;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton({ label, className, children, type = "button", ...rest }, ref) {
  return (
    <Tooltip label={label}>
      <button ref={ref} type={type} aria-label={label} className={["icon-btn", className].filter(Boolean).join(" ")} {...rest}>
        {children}
      </button>
    </Tooltip>
  );
});
