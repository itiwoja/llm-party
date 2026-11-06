import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** 指示の入力欄の最大行数（CMP-005）。それ以上は内部でスクロール */
const MAX_LINES = 10;

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onSubmit"> {
  label: string;
  value: string;
  /** Enter（変換中を除く）で呼ぶ。Shift+Enter は改行（NFR-031） */
  onSubmit(): void;
}

export const ComposerInput = forwardRef<HTMLTextAreaElement, Props>(function ComposerInput({ label, value, onSubmit, onKeyDown, ...rest }, ref) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current!);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight);
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${Math.min(el.scrollHeight + (el.offsetHeight - el.clientHeight), line * MAX_LINES + pad)}px`;
  }, [value]);

  return (
    <div className="field">
      <label className="field-label" htmlFor={rest.id}>{label}</label>
      <textarea
        ref={inner}
        rows={1}
        className="input composer"
        value={value}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        {...rest}
      />
    </div>
  );
});
