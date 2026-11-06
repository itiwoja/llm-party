import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { CircleAlert } from "lucide-react";

interface FieldProps {
  label: string;
  /** 欄の下に出す説明（CP の補足） */
  hint?: string;
  /** 欄の下に赤い文字とアイコンで出す */
  error?: string;
}

function Wrapper({ label, hint, error, id, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">{label}</label>
      {children}
      {hint && !error ? <p id={`${id}-hint`} className="field-hint">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="field-error" role="alert"><CircleAlert aria-hidden />{error}</p> : null}
    </div>
  );
}

/** CMP-005（単一行・数値）。ラベルは常に欄の上に出す */
export const TextField = forwardRef<HTMLInputElement, FieldProps & InputHTMLAttributes<HTMLInputElement>>(function TextField(
  { label, hint, error, className, ...rest },
  ref,
) {
  const id = useId();
  const described = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <Wrapper label={label} hint={hint} error={error} id={id}>
      <input ref={ref} id={id} className={["input", numeric(rest.type) && "numeric", className].filter(Boolean).join(" ")} aria-invalid={error ? true : undefined} aria-describedby={described} {...rest} />
    </Wrapper>
  );
});

const numeric = (type?: string) => type === "number";

/** CMP-005（複数行）。高さは呼び出し側が決める。指示の入力欄は ComposerInput を使う */
export const TextArea = forwardRef<HTMLTextAreaElement, FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { label, hint, error, className, ...rest },
  ref,
) {
  const id = useId();
  const described = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <Wrapper label={label} hint={hint} error={error} id={id}>
      <textarea ref={ref} id={id} className={["input", className].filter(Boolean).join(" ")} aria-invalid={error ? true : undefined} aria-describedby={described} {...rest} />
    </Wrapper>
  );
});
