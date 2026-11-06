import { useState } from "react";
import { api } from "../../api";
import { useAppData } from "../../app-data";
import { Button } from "../../components/Button";
import { SelectField } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { TextArea, TextField } from "../../components/Field";
import { CP } from "../../copy";
import { PG1 } from "./copy";
import type { Workspace } from "./types";

const NO_PRESET = "none";
const AUTO_APPROVE = { inherit: null, on: true, off: false } as const;
type AutoApproveChoice = keyof typeof AUTO_APPROVE;
const toChoice = (value: boolean | null): AutoApproveChoice => (value === null ? "inherit" : value ? "on" : "off");

/** プロジェクト設定（API-043）。閉じるたびに作り直すので、開いたときの値から始まる */
export function ProjectDialog({ project, onClose, onSaved }: { project: Workspace; onClose(): void; onSaved(): void }) {
  const { presets } = useAppData();
  const [name, setName] = useState(project.name);
  const [instructions, setInstructions] = useState(project.instructions ?? "");
  const [presetId, setPresetId] = useState(project.defaultPresetId ?? NO_PRESET);
  const [autoApprove, setAutoApprove] = useState(toChoice(project.autoApprove));
  const [error, setError] = useState("");

  async function save() {
    setError("");
    try {
      await api.patch(`/workspaces/${project.id}`, {
        name,
        instructions,
        defaultPresetId: presetId === NO_PRESET ? null : presetId,
        autoApprove: AUTO_APPROVE[autoApprove],
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={PG1.projectSettings}
      description={project.path}
      footer={
        <>
          <Button onClick={onClose}>{PG1.cancel}</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>{CP.save}</Button>
        </>
      }
    >
      <div className="project-form">
        <TextField label={PG1.projectName} value={name} onChange={(e) => setName(e.target.value)} />
        <TextArea label={PG1.projectInstructions} hint={PG1.projectInstructionsHint} rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <SelectField
          label={PG1.projectPreset}
          value={presetId}
          onValueChange={setPresetId}
          options={[{ value: NO_PRESET, label: PG1.projectPresetNone }, ...presets.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <SelectField
          label={PG1.projectAutoApprove}
          value={autoApprove}
          onValueChange={(value) => setAutoApprove(value as AutoApproveChoice)}
          options={[
            { value: "inherit", label: PG1.autoApproveInherit },
            { value: "on", label: PG1.autoApproveOn },
            { value: "off", label: PG1.autoApproveOff },
          ]}
        />
        {error ? <p className="field-error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}
