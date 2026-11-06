import { ChevronDown, X } from "lucide-react";
import { useState } from "react";
import { api, ApiRequestError } from "../../api";
import { Button } from "../../components/Button";
import { SelectField, SwitchField } from "../../components/Controls";
import { TextArea, TextField } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { DropdownMenu } from "../../components/Menu";
import { useToast } from "../../components/Toast";
import { CP } from "../../copy";
import type { AdapterItem, ModelItem } from "../models/types";
import { PG4, PG4_MISSING } from "./copy";
import { contextFor } from "./defaults";
import { CONTEXT_MIN } from "./limits";
import { QWEN_CHAT, QWEN_CODING, QWEN_GENERAL, type Recommended, type Sampling } from "./qwen";

/** GET /api/presets の1件 */
export interface PresetFull {
  id: string;
  name: string;
  modelId: string;
  adapters: { adapterId: string; scale: number }[];
  sampling: Sampling;
  systemPrompt: string | null;
  thinking: boolean;
  contextSize: number;
}

/** 入力中は文字列で持つ（「0.」などの途中の形を壊さない） */
export interface FormValues {
  name: string;
  modelId: string;
  adapters: { adapterId: string; scale: string }[];
  sampling: Record<keyof Sampling, string>;
  systemPrompt: string;
  thinking: boolean;
  contextSize: string;
}

const strings = (s: Sampling): Record<keyof Sampling, string> => ({
  temperature: String(s.temperature), topP: String(s.topP), topK: String(s.topK),
  minP: String(s.minP), presencePenalty: String(s.presencePenalty), repeatPenalty: String(s.repeatPenalty),
});

export function valuesOf(preset: PresetFull): FormValues {
  return {
    name: preset.name,
    modelId: preset.modelId,
    adapters: preset.adapters.map((a) => ({ adapterId: a.adapterId, scale: String(a.scale) })),
    sampling: strings(preset.sampling),
    systemPrompt: preset.systemPrompt ?? "",
    thinking: preset.thinking,
    contextSize: String(preset.contextSize),
  };
}

/** 新規の初期値：最初のモデル、「対話」の値、設定の文脈長 */
export function newValues(models: ModelItem[], defaultContextSize: number): FormValues {
  const model = models[0];
  return {
    name: "",
    modelId: model?.id ?? "",
    adapters: [],
    sampling: strings(QWEN_CHAT.sampling),
    systemPrompt: "",
    thinking: QWEN_CHAT.thinking,
    contextSize: String(contextFor(defaultContextSize, model?.trainContext ?? null)),
  };
}

const SAMPLING_FIELDS: { key: keyof Sampling; label: string; min?: number; max?: number; step: number }[] = [
  { key: "temperature", label: PG4.temperature, min: 0, step: 0.05 },
  { key: "topP", label: PG4.topP, min: 0, max: 1, step: 0.05 },
  { key: "topK", label: PG4.topK, min: 0, step: 1 },
  { key: "minP", label: PG4.minP, min: 0, max: 1, step: 0.01 },
  { key: "presencePenalty", label: PG4.presencePenalty, step: 0.1 },
  { key: "repeatPenalty", label: PG4.repeatPenalty, min: 0, step: 0.05 },
];

interface Errors { name?: string; adapters?: string; contextSize?: string; general?: string }

interface Props {
  preset: PresetFull | null;
  initial: FormValues;
  models: ModelItem[];
  adapters: AdapterItem[];
  onSaved(preset: PresetFull): void;
}

/** SEC-004-02 編集。保存は API-061（新規）/ API-062（編集）。入力欄ごとにその場でエラーを出す */
export function PresetForm({ preset, initial, models, adapters, onSaved }: Props) {
  const toast = useToast();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  const model = models.find((m) => m.id === values.modelId);
  // BR-08：ベースモデルが一致する LoRA だけ選べる
  const usable = adapters.filter((a) => a.baseModelId === values.modelId);
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  function changeModel(modelId: string) {
    // モデルを変えたら、合わなくなった LoRA は外す
    setValues((v) => ({ ...v, modelId, adapters: v.adapters.filter((row) => adapters.find((a) => a.id === row.adapterId)?.baseModelId === modelId) }));
  }

  function fill(recommended: Recommended) {
    setValues((v) => ({ ...v, sampling: strings(recommended.sampling), thinking: recommended.thinking }));
  }

  function addAdapter() {
    const free = usable.find((a) => !values.adapters.some((row) => row.adapterId === a.id));
    if (free) set("adapters", [...values.adapters, { adapterId: free.id, scale: "1" }]);
  }

  async function save() {
    const next: Errors = {};
    const contextSize = Number(values.contextSize);
    if (model?.trainContext != null && (!Number.isInteger(contextSize) || contextSize < CONTEXT_MIN || contextSize > model.trainContext)) {
      next.contextSize = PG4.contextRange(CONTEXT_MIN, model.trainContext);
    }
    if (Object.keys(next).length > 0) return setErrors(next);
    setErrors({});
    setBusy(true);
    try {
      const body = {
        name: values.name.trim(),
        modelId: values.modelId,
        adapters: values.adapters.map((row) => ({ adapterId: row.adapterId, scale: Number(row.scale) })),
        sampling: Object.fromEntries(SAMPLING_FIELDS.map((f) => [f.key, Number(values.sampling[f.key])])),
        systemPrompt: values.systemPrompt.trim() ? values.systemPrompt : null,
        thinking: values.thinking,
        contextSize,
      };
      const saved = preset ? await api.patch<PresetFull>(`/presets/${preset.id}`, body) : await api.post<PresetFull>("/presets", body);
      toast(CP.saved);
      onSaved(saved);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // CP-115〜117 は API が同じ文で返す。どの欄かは文の頭で見分ける
      if (err instanceof ApiRequestError && message.startsWith("同じ名前")) setErrors({ name: PG4.nameTaken });
      else if (message.startsWith("文脈長の範囲外")) setErrors({ contextSize: message });
      else if (message.startsWith("ベースモデルが違う")) setErrors({ adapters: PG4.adapterMismatch });
      else setErrors({ general: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="preset-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <TextField label={PG4.name} value={values.name} onChange={(e) => set("name", e.target.value)} error={errors.name} required spellCheck={false} />
      <SelectField label={PG4.model} value={values.modelId} onValueChange={changeModel} options={models.map((m) => ({ value: m.id, label: m.name }))} />

      <fieldset className="preset-adapters">
        <legend className="field-label">{PG4.adaptersLegend}</legend>
        {values.adapters.map((row, index) => (
          <div className="preset-adapter-row" key={row.adapterId}>
            <SelectField
              label={PG4.adapter}
              hideLabel
              value={row.adapterId}
              onValueChange={(id) => set("adapters", values.adapters.map((r, i) => (i === index ? { ...r, adapterId: id } : r)))}
              options={usable.filter((a) => a.id === row.adapterId || !values.adapters.some((r) => r.adapterId === a.id)).map((a) => ({ value: a.id, label: a.name }))}
            />
            <TextField
              label={PG4.scale}
              type="number"
              min={0}
              step={0.1}
              value={row.scale}
              onChange={(e) => set("adapters", values.adapters.map((r, i) => (i === index ? { ...r, scale: e.target.value } : r)))}
            />
            <IconButton label={CP.delete} onClick={() => set("adapters", values.adapters.filter((_, i) => i !== index))}><X aria-hidden /></IconButton>
          </div>
        ))}
        {errors.adapters ? <p className="field-error" role="alert">{errors.adapters}</p> : null}
        <div>
          <Button size="sm" onClick={addAdapter} disabled={usable.every((a) => values.adapters.some((r) => r.adapterId === a.id))}>{PG4_MISSING.addAdapter}</Button>
        </div>
      </fieldset>

      <div className="preset-sampling">
        {SAMPLING_FIELDS.map((f) => (
          <TextField
            key={f.key}
            label={f.label}
            type="number"
            min={f.min}
            max={f.max}
            step={f.step}
            value={values.sampling[f.key]}
            onChange={(e) => set("sampling", { ...values.sampling, [f.key]: e.target.value })}
            required
          />
        ))}
      </div>

      <TextArea label={PG4.systemPrompt} rows={4} value={values.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} />
      <SwitchField label={PG4.thinking} checked={values.thinking} onCheckedChange={(v) => set("thinking", v)} />
      <TextField label={PG4.contextSize} type="number" min={CONTEXT_MIN} step={1} value={values.contextSize} onChange={(e) => set("contextSize", e.target.value)} error={errors.contextSize} required />

      {errors.general ? <p className="field-error" role="alert">{errors.general}</p> : null}
      <div className="preset-actions">
        <DropdownMenu
          trigger={<Button icon={<ChevronDown aria-hidden />}>{PG4.fillQwen}</Button>}
          menu={[
            { label: QWEN_CODING.name, onSelect: () => fill(QWEN_CODING) },
            { label: QWEN_CHAT.name, onSelect: () => fill(QWEN_CHAT) },
            { label: PG4_MISSING.qwenGeneral, onSelect: () => fill(QWEN_GENERAL) },
          ]}
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!values.modelId}>{CP.save}</Button>
      </div>
    </form>
  );
}
