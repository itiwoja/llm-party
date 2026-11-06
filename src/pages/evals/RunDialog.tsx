import { useState } from "react";
import { api } from "../../api";
import { useAppData } from "../../app-data";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { CP } from "../../copy";
import { navigate } from "../../router";
import { PG5, PG5_MISSING } from "./copy";

function Check({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

const toggle = (list: string[], value: string, on: boolean) => (on ? [...list, value] : list.filter((v) => v !== value));

/** FR-016：プリセット（複数）とタグを選んで実行。実行したら最初のランの PG-006 へ */
export function RunDialog({ setId, tags, onClose }: { setId: string; tags: string[]; onClose(): void }) {
  const { presets } = useAppData();
  const [picked, setPicked] = useState<string[]>([]);
  const [pickedTags, setPickedTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setBusy(true);
    setError("");
    try {
      const { runIds } = await api.post<{ runIds: string[] }>("/eval-runs", {
        evalSetId: setId,
        presetIds: picked,
        ...(pickedTags.length ? { tags: pickedTags } : {}),
      });
      onClose();
      navigate(`/runs/${runIds[0]}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={PG5.runTitle}
      footer={
        <>
          <Button onClick={onClose}>{CP.cancel}</Button>
          <Button variant="primary" loading={busy} disabled={picked.length === 0} onClick={() => void start()}>{PG5.runCount(picked.length)}</Button>
        </>
      }
    >
      <div className="run-dialog">
        {presets.length === 0 ? <p className="empty">{PG5_MISSING.noPresets}</p> : null}
        <div className="checks" role="group" aria-label={PG5.runTitle}>
          {presets.map((p) => <Check key={p.id} label={p.name} checked={picked.includes(p.id)} onChange={(on) => setPicked((l) => toggle(l, p.id, on))} />)}
        </div>
        {tags.length ? (
          <fieldset className="tag-fieldset">
            <legend className="field-label">{PG5.tagFilter}</legend>
            <div className="checks checks-row">
              {tags.map((tag) => <Check key={tag} label={tag} checked={pickedTags.includes(tag)} onChange={(on) => setPickedTags((l) => toggle(l, tag, on))} />)}
            </div>
          </fieldset>
        ) : null}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}
