import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
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

/** つまみと目盛りのバー。保存は指を離したときなので、途中の位置は手元に持つ */
function EffortBar({ label, value, options, defaultValue, onValueChange, disabled }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const index = Math.max(0, options.findIndex((o) => o.value === shown));
  const text = options[index]?.label ?? "";

  useEffect(() => setDraft(null), [value]);

  function commit() {
    if (draft !== null && draft !== value) onValueChange(draft);
  }

  return (
    <>
      <div className="effort-head">
        <span className="effort-title">{text}</span>
        <IconButton
          className="effort-reset"
          label={CP.effortReset}
          disabled={disabled || shown === defaultValue}
          onClick={() => {
            setDraft(defaultValue);
            onValueChange(defaultValue);
          }}
        >
          <RotateCcw aria-hidden />
        </IconButton>
      </div>
      <div className="effort-track">
        <span className="effort-stops" aria-hidden>
          {options.map((o) => <span key={o.value} />)}
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
          onChange={(e) => setDraft(options[Number(e.target.value)]?.value ?? null)}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerUp={commit}
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
