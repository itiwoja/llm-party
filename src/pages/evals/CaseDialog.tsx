import { useState } from "react";
import { Button } from "../../components/Button";
import { RadioField, SelectField, SwitchField } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { TextArea, TextField } from "../../components/Field";
import { CP } from "../../copy";
import { PG5, PG5_MISSING } from "./copy";
import type { EvalCase, Grader } from "./types";

type GraderKind = "contains" | "regex" | "manual" | "test";

interface Form {
  name: string;
  kind: "chat" | "agent";
  input: string;
  fixture: string;
  graderKind: GraderKind;
  exact: boolean;
  expected: string;
  ignoreCase: boolean;
  scale: "pass_fail" | "1to5";
  rubric: string;
  command: string;
  tags: string;
}

function formOf(item: EvalCase | null): Form {
  const g = item?.grader;
  return {
    name: item?.name ?? "",
    kind: item?.kind ?? "chat",
    input: item?.input ?? "",
    fixture: item?.fixture ?? "",
    graderKind: !g ? "contains" : g.type === "match" ? (g.mode === "regex" ? "regex" : "contains") : g.type,
    exact: g?.type === "match" && g.mode === "exact",
    expected: g?.type === "match" ? g.expected : "",
    ignoreCase: g?.type === "match" ? g.ignoreCase : false,
    scale: g?.type === "manual" ? g.scale : "pass_fail",
    rubric: g?.type === "manual" ? g.rubric ?? "" : "",
    command: g?.type === "test" ? g.command : "",
    tags: item?.tags.join(", ") ?? "",
  };
}

function graderOf(f: Form): Grader {
  if (f.graderKind === "manual") return { type: "manual", scale: f.scale, ...(f.rubric.trim() ? { rubric: f.rubric.trim() } : {}) };
  if (f.graderKind === "test") return { type: "test", command: f.command.trim() };
  return { type: "match", mode: f.graderKind === "regex" ? "regex" : f.exact ? "exact" : "contains", expected: f.expected, ignoreCase: f.ignoreCase };
}

/** FR-015 のケース編集。採点方法で項目が変わる（match / manual / test） */
export function CaseDialog({ item, taken, onSave, onClose }: { item: EvalCase | null; taken: string[]; onSave(item: EvalCase): void; onClose(): void }) {
  const [form, setForm] = useState(() => formOf(item));
  const patch = (change: Partial<Form>) => setForm((current) => ({ ...current, ...change }));
  const name = form.name.trim();
  const duplicate = taken.includes(name);
  const agent = form.kind === "agent";
  const valid =
    name !== "" && !duplicate && form.input.trim() !== "" &&
    (!agent || form.fixture.trim() !== "") &&
    (form.graderKind !== "test" || form.command.trim() !== "");

  function submit() {
    onSave({
      ...(item?.id ? { id: item.id } : {}),
      name,
      kind: form.kind,
      input: form.input,
      fixture: agent ? form.fixture.trim() : null,
      grader: graderOf(form),
      tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    });
  }

  const graderOptions = [
    { value: "contains", label: PG5.graders.contains },
    { value: "regex", label: PG5.graders.regex },
    { value: "manual", label: PG5.graders.manual },
    // test はフォルダのある agent のケースだけ（API の検証と同じ）
    ...(agent ? [{ value: "test", label: PG5.graders.test }] : []),
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={item ? PG5_MISSING.editCase : PG5_MISSING.newCase}
      footer={
        <>
          <Button onClick={onClose}>{CP.cancel}</Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>{CP.save}</Button>
        </>
      }
    >
      <form className="dialog-form case-form" onSubmit={(e) => { e.preventDefault(); if (valid) submit(); }}>
        <TextField label={PG5.columns.name} value={form.name} onChange={(e) => patch({ name: e.target.value })} error={duplicate ? PG5_MISSING.nameTaken : undefined} autoFocus />
        <SelectField
          label={PG5.labels.kind}
          value={form.kind}
          onValueChange={(kind) => patch({ kind: kind as Form["kind"], ...(kind === "chat" && form.graderKind === "test" ? { graderKind: "contains" as const } : {}) })}
          options={[{ value: "chat", label: PG5.kinds.chat }, { value: "agent", label: PG5.kinds.agent }]}
        />
        <TextArea label={PG5.labels.input} rows={4} value={form.input} onChange={(e) => patch({ input: e.target.value })} />
        {agent ? <TextField label={PG5.labels.fixture} value={form.fixture} onChange={(e) => patch({ fixture: e.target.value })} spellCheck={false} /> : null}
        <SelectField label={PG5.labels.grader} value={form.graderKind} onValueChange={(graderKind) => patch({ graderKind: graderKind as GraderKind })} options={graderOptions} />
        {form.graderKind === "contains" || form.graderKind === "regex" ? (
          <>
            <TextField label={PG5_MISSING.expected} value={form.expected} onChange={(e) => patch({ expected: e.target.value })} spellCheck={false} />
            {form.graderKind === "contains" ? (
              <SelectField
                label={PG5_MISSING.matchMode}
                value={form.exact ? "exact" : "contains"}
                onValueChange={(mode) => patch({ exact: mode === "exact" })}
                options={[{ value: "contains", label: PG5_MISSING.modeContains }, { value: "exact", label: PG5_MISSING.modeExact }]}
              />
            ) : null}
            <SwitchField label={PG5_MISSING.ignoreCase} checked={form.ignoreCase} onCheckedChange={(ignoreCase) => patch({ ignoreCase })} />
          </>
        ) : null}
        {form.graderKind === "manual" ? (
          <>
            <div className="field">
              <span className="field-label">{PG5_MISSING.scale}</span>
              <RadioField
                label={PG5_MISSING.scale}
                value={form.scale}
                onValueChange={(scale) => patch({ scale: scale as Form["scale"] })}
                options={[{ value: "pass_fail", label: PG5_MISSING.scalePassFail }, { value: "1to5", label: PG5_MISSING.scaleOneToFive }]}
              />
            </div>
            <TextArea label={PG5_MISSING.rubric} rows={2} value={form.rubric} onChange={(e) => patch({ rubric: e.target.value })} />
          </>
        ) : null}
        {form.graderKind === "test" ? <TextField label={PG5_MISSING.command} value={form.command} onChange={(e) => patch({ command: e.target.value })} spellCheck={false} /> : null}
        <TextField label={PG5.labels.tags} hint={PG5_MISSING.tagsHint} value={form.tags} onChange={(e) => patch({ tags: e.target.value })} />
      </form>
    </Dialog>
  );
}
