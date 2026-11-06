import * as Select from "@radix-ui/react-select";
import * as Switch from "@radix-ui/react-switch";
import * as Radio from "@radix-ui/react-radio-group";
import { Check, ChevronDown } from "lucide-react";
import { useId } from "react";

export interface Option { value: string; label: string }

interface SelectProps {
  value: string;
  onValueChange(value: string): void;
  options: Option[];
  /** ラベル。visible なら欄の上に出し、false なら読み上げ専用 */
  label: string;
  hideLabel?: boolean;
  /** 見出しの大きさで出す（メインのプリセット名） */
  title?: boolean;
  disabled?: boolean;
}

/** CMP-015（セレクト）。プリセット名などは等幅にしない */
export function SelectField({ value, onValueChange, options, label, hideLabel, title, disabled }: SelectProps) {
  const id = useId();
  return (
    <div className="field">
      <label id={id} className={hideLabel ? "sr-only" : "field-label"}>{label}</label>
      <Select.Root value={value} onValueChange={onValueChange} disabled={disabled}>
        <Select.Trigger className={`select-trigger${title ? " select-title" : ""}`} aria-labelledby={id}>
          <Select.Value />
          <Select.Icon><ChevronDown aria-hidden /></Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="menu select-content" position="popper" sideOffset={4}>
            <Select.Viewport>
              {options.map((o) => (
                <Select.Item key={o.value} value={o.value} className="menu-item select-item">
                  <Select.ItemText>{o.label}</Select.ItemText>
                  <Select.ItemIndicator className="select-check"><Check aria-hidden /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

/** CMP-015（スイッチ。思考モードなど） */
export function SwitchField({ checked, onCheckedChange, label }: { checked: boolean; onCheckedChange(v: boolean): void; label: string }) {
  const id = useId();
  return (
    <div className="switch-field">
      <Switch.Root id={id} className="switch" checked={checked} onCheckedChange={onCheckedChange}>
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/** CMP-015（ラジオ。テーマ・○× 採点） */
export function RadioField({ value, onValueChange, options, label }: { value: string; onValueChange(v: string): void; options: Option[]; label: string }) {
  return (
    <Radio.Root className="radio-group" value={value} onValueChange={onValueChange} aria-label={label}>
      {options.map((o) => {
        const id = `${label}-${o.value}`;
        return (
          <div className="radio-item" key={o.value}>
            <Radio.Item id={id} value={o.value} className="radio"><Radio.Indicator className="radio-dot" /></Radio.Item>
            <label htmlFor={id}>{o.label}</label>
          </div>
        );
      })}
    </Radio.Root>
  );
}
