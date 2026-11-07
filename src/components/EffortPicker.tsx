import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { CP } from "../copy";
import type { Option } from "./Controls";
import { IconButton } from "./IconButton";

interface Props {
  /** 読み上げ名 */
  label: string;
  value: string;
  /** 左から弱い順 */
  options: Option[];
  /** ↺ で戻す値 */
  defaultValue: string;
  /** 指を離したときに呼ぶ（動かしている途中では呼ばない） */
  onValueChange(value: string): void;
  disabled?: boolean;
}

/** バーの位置（0〜1）を CSS に渡す */
type BarStyle = CSSProperties & { "--p": number };

/** つまみと目盛りのバー。保存は指を離したときなので、途中の位置は手元に持つ */
function EffortBar({ label, value, options, defaultValue, onValueChange, disabled }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  /** ドラッグ中の指の位置（0〜1）。ドラッグ中でなければ null */
  const [dragP, setDragP] = useState<number | null>(null);
  /** 押した所から 2px 以上動かしたら true。滑りを切って指に直接つける */
  const [moved, setMoved] = useState(false);
  const pressed = useRef(false);
  const startX = useRef(0);

  const last = Math.max(1, options.length - 1);
  const settled = Math.max(0, options.findIndex((o) => o.value === (draft ?? value)));
  const index = dragP === null ? settled : Math.round(dragP * last);
  const pos = dragP ?? settled / last;
  const text = options[index]?.label ?? "";

  useEffect(() => setDraft(null), [value]);

  /** 指の位置を、左右 16px 内側を 0〜1 とした値にする */
  function at(e: PointerEvent<HTMLInputElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left - 16) / (r.width - 32)));
  }

  function commit() {
    if (draft !== null && draft !== value) onValueChange(draft);
  }

  function release(e: PointerEvent<HTMLInputElement>) {
    if (!pressed.current) return;
    pressed.current = false;
    const next = options[Math.round(at(e) * last)]?.value ?? null;
    setDragP(null);
    setMoved(false);
    if (next === null) return;
    setDraft(next);
    if (next !== value) onValueChange(next);
  }

  function cancel() {
    if (!pressed.current) return;
    pressed.current = false;
    setDragP(null);
    setMoved(false);
  }

  const style: BarStyle = { "--p": pos };

  return (
    <>
      <div className="effort-head">
        <span className="effort-title">{text}</span>
        <IconButton
          className="effort-reset"
          label={CP.effortReset}
          disabled={disabled || options[index]?.value === defaultValue}
          onClick={() => {
            setDraft(defaultValue);
            onValueChange(defaultValue);
          }}
        >
          <RotateCcw aria-hidden />
        </IconButton>
      </div>
      <div className="effort-track" style={style} data-dragging={moved || undefined}>
        <span className="effort-fill" aria-hidden />
        <span className="effort-rail" aria-hidden>
          <span className="effort-cover" />
        </span>
        <span className="effort-stops" aria-hidden>
          {options.map((o, i) => <span key={o.value} data-on={i / last <= pos + 0.001 || undefined} />)}
        </span>
        <span className="effort-rail" aria-hidden>
          <span className="effort-thumb" />
        </span>
        <input
          type="range"
          min="0"
          max={options.length - 1}
          step="1"
          value={index}
          aria-label={label}
          aria-valuetext={text}
          disabled={disabled}
          onChange={(e) => {
            // ドラッグ中は指の位置で動かすので、段に飛ぶ変更は受けない
            if (!pressed.current) setDraft(options[Number(e.target.value)]?.value ?? null);
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            pressed.current = true;
            startX.current = e.clientX;
            setDragP(at(e));
          }}
          onPointerMove={(e) => {
            if (!pressed.current) return;
            if (Math.abs(e.clientX - startX.current) > 2) setMoved(true);
            setDragP(at(e));
          }}
          onPointerUp={release}
          onPointerCancel={cancel}
          onKeyUp={commit}
        />
      </div>
    </>
  );
}

/** CMP-024。入力欄の思考の段階。今の値のボタンから、バーのカードを開く */
export function EffortPicker(props: Props) {
  const current = props.options.find((o) => o.value === props.value)?.label ?? "";
  return (
    <Popover.Root>
      <Popover.Trigger className="select-trigger select-compact" aria-label={`${props.label}: ${current}`} disabled={props.disabled}>
        <span>{current}</span>
        <span><ChevronDown aria-hidden /></span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="effort-card"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
        >
          <EffortBar {...props} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
