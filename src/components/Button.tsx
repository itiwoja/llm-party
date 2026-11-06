import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** 文言はそのまま、左にスピナーを出して二重送信を防ぐ */
  loading?: boolean;
  icon?: ReactNode;
  /** 承認カードの却下など、secondary のまま文字だけ danger にする */
  tone?: "danger";
}

/** CMP-001。1画面の主ボタン（primary）は1つ */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", size = "md", loading, icon, tone, className, children, disabled, type = "button", ...rest },
  ref,
) {
  const classes = ["btn", `btn-${variant}`, size === "sm" && "btn-sm", tone === "danger" && "btn-tone-danger", className].filter(Boolean).join(" ");
  return (
    <button ref={ref} type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <LoaderCircle className="spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});
