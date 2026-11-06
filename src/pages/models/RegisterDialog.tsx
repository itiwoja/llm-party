import { useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/Button";
import { SelectField, RadioField } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";
import { PG3 } from "./copy";
import { ErrorLine } from "./ErrorLine";
import { errorMessage } from "./format";
import type { ModelItem } from "./types";

interface Props {
  kind: "model" | "adapter";
  /** pickFile() で選んだパス、または完了した LoRA の DL の保存先 */
  path: string;
  /** DL したファイルの登録は参照に決まっている（登録の方法を選ばせない） */
  fixedReference?: boolean;
  models: ModelItem[];
  onClose(): void;
  /** 登録できた */
  onDone(): void;
}

/** CP-084 のダイアログ。登録の方法（CP-103）、LoRA ならベースモデル（CP-104）。正しいかは登録 API が確かめる */
export function RegisterDialog({ kind, path, fixedReference, models, onClose, onDone }: Props) {
  const [mode, setMode] = useState<"reference" | "copy">("reference");
  const [name, setName] = useState("");
  const [baseModelId, setBaseModelId] = useState(models[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    if (!path.toLowerCase().endsWith(".gguf")) return setError(PG3.notGguf);
    setBusy(true);
    try {
      const body = { path, mode: fixedReference ? "reference" : mode, ...(name.trim() ? { name: name.trim() } : {}) };
      if (kind === "model") await api("/models", body);
      else await api("/adapters", { ...body, baseModelId });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={PG3.register}>
      <form className="dialog-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="models-path numeric">{path}</p>
        {kind === "adapter" ? (
          <SelectField label={PG3.baseModel} value={baseModelId} onValueChange={setBaseModelId} options={models.map((m) => ({ value: m.id, label: m.name }))} />
        ) : null}
        <TextField label={PG3.name} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        {fixedReference ? null : (
          <div className="field">
            <span className="field-label">{PG3.registerMode}</span>
            <RadioField
              label={PG3.registerMode}
              value={mode}
              onValueChange={(v) => setMode(v as "reference" | "copy")}
              options={[{ value: "reference", label: PG3.modeOptions.reference }, { value: "copy", label: PG3.modeOptions.copy }]}
            />
          </div>
        )}
        {error ? <ErrorLine message={error} /> : null}
        <div className="dialog-footer">
          <Button onClick={onClose}>{PG3.cancel}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={kind === "adapter" && !baseModelId}>{PG3.register}</Button>
        </div>
      </form>
    </Dialog>
  );
}
