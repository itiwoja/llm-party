import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { useServerEvent } from "../../app-data";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { ListRow } from "../../components/ListRow";
import { Table, type Column } from "../../components/Table";
import { useToast } from "../../components/Toast";
import { CP, MISSING_COPY } from "../../copy";
import { ManageLayout } from "../../layouts";
import { pickFile, pickFolder } from "../../platform";
import { hrefOf, navigate, useRoute } from "../../router";
import { setPendingCompare } from "../compare/pick";
import { dateText, percentText } from "../runs/format";
import { CaseDialog } from "./CaseDialog";
import { PG5, PG5_MISSING } from "./copy";
import { RunDialog } from "./RunDialog";
import type { EvalCase, EvalSetFull, EvalSetSummary, RunItem } from "./types";
import "../runs/runs.css";
import "./evals.css";

interface Draft { name: string; description: string; fixturesDir: string; cases: EvalCase[] }

const draftOf = (set: EvalSetFull | null): Draft => ({
  name: set?.name ?? "",
  description: set?.description ?? "",
  fixturesDir: set?.fixturesDir ?? "",
  cases: set?.cases ?? [],
});

const graderLabel = (item: EvalCase) =>
  item.grader.type === "match" ? (item.grader.mode === "regex" ? PG5.graders.regex : PG5.graders.contains) : item.grader.type === "manual" ? PG5.graders.manual : PG5.graders.test;

/** PG-005 評価セット（管理の型）。左に一覧、右にケースと最近のラン（SEC-005-01〜03） */
export function EvalsPage() {
  const route = useRoute();
  const routeId = route.page === "evals" ? route.id : undefined;
  const toast = useToast();
  const [sets, setSets] = useState<EvalSetSummary[] | null>(null);
  const [saved, setSaved] = useState<EvalSetFull | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState<EvalSetSummary | null>(null);
  const [duplicateFor, setDuplicateFor] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<{ line: number; reason: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const creating = routeId === "new";
  const selected = sets?.find((s) => s.id === routeId) ?? null;

  const loadSets = useCallback(async () => {
    setSets((await api.get<{ items: EvalSetSummary[] }>("/eval-sets")).items);
  }, []);
  useEffect(() => { void loadSets().catch(() => setSets([])); }, [loadSets]);

  // id が無い・見つからないときは先頭を開く。1 件も無ければ空の状態のまま
  useEffect(() => {
    if (!sets || creating || selected || !sets[0]) return;
    navigate(`/evals/${sets[0].id}`, true);
  }, [sets, creating, selected]);

  const loadSet = useCallback(async (id: string) => {
    const full = await api.get<EvalSetFull>(`/eval-sets/${id}`);
    setSaved(full);
    setDraft(draftOf(full));
    setRuns((await api.get<{ items: RunItem[] }>(`/eval-runs?evalSetId=${id}`)).items);
  }, []);

  const selectedId = selected?.id;
  useEffect(() => {
    setError("");
    setImportErrors([]);
    if (creating) { setSaved(null); setDraft(draftOf(null)); setRuns([]); return; }
    if (selectedId) void loadSet(selectedId).catch(() => undefined);
  }, [creating, selectedId, loadSet]);

  // 実行が終わったら最近のランを引き直す
  useServerEvent((event) => {
    if ((event.event === "eval.finished" || event.event === "eval.progress") && selectedId) {
      void api.get<{ items: RunItem[] }>(`/eval-runs?evalSetId=${selectedId}`).then((r) => setRuns(r.items)).catch(() => undefined);
      if (event.event === "eval.finished") void loadSets().catch(() => undefined);
    }
  });

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftOf(saved)), [draft, saved]);
  const tags = useMemo(() => [...new Set((saved?.cases ?? []).flatMap((c) => c.tags))].sort(), [saved]);

  /** API-072 / 071。保存したセットを返す */
  async function save(): Promise<EvalSetFull | null> {
    setError("");
    setBusy(true);
    const body = { name: draft.name.trim(), description: draft.description.trim() || null, fixturesDir: draft.fixturesDir.trim() || null };
    try {
      if (creating) {
        const created = await api.post<{ id: string }>("/eval-sets", body);
        await loadSets();
        toast(CP.saved);
        navigate(`/evals/${created.id}`, true);
        return null;
      }
      const full = await api.put<EvalSetFull>(`/eval-sets/${saved!.id}`, { ...body, cases: draft.cases });
      setSaved(full);
      setDraft(draftOf(full));
      await loadSets();
      toast(CP.saved);
      return full;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** 実行・取込・書出はサーバーに保存されたセットで動くので、変更があれば先に保存する */
  async function ensureSaved(): Promise<boolean> {
    if (!dirty) return true;
    return (await save()) !== null;
  }

  async function startRun() {
    if (await ensureSaved()) setRunning(true);
  }

  async function importFile(onDuplicate: "overwrite" | "skip", file: string) {
    setError("");
    try {
      const result = await api.post<{ added: number; skipped: number; errors: { line: number; reason: string }[] }>(`/eval-sets/${saved!.id}/import`, { path: file, onDuplicate });
      setImportErrors(result.errors);
      await loadSet(saved!.id);
      await loadSets();
      toast(PG5_MISSING.importDone(result.added, result.skipped));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function startImport() {
    if (!(await ensureSaved())) return;
    const file = await pickFile();
    if (!file) return;
    // 同名の有無は取り込んでみないと分からないので、既存のケースがあるときだけ先に聞く
    if (draft.cases.length > 0) setDuplicateFor(file);
    else await importFile("skip", file);
  }

  async function exportFile() {
    if (!(await ensureSaved())) return;
    const file = await pickFile();
    if (!file) return;
    setError("");
    try {
      await api.post(`/eval-sets/${saved!.id}/export`, { path: file });
      toast(CP.saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeSet(set: EvalSetSummary) {
    try {
      await api.delete(`/eval-sets/${set.id}`);
      setDeleting(null);
      await loadSets();
      if (routeId === set.id) navigate("/evals", true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(null);
    }
  }

  async function choosePath() {
    const dir = await pickFolder();
    if (dir) setDraft((d) => ({ ...d, fixturesDir: dir }));
  }

  const setCases = (cases: EvalCase[]) => setDraft((d) => ({ ...d, cases }));
  const move = (index: number, by: -1 | 1) => {
    const next = [...draft.cases];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    setCases(next);
  };

  const list = (
    <>
      <Button onClick={() => navigate("/evals/new")}>{PG5.newSet}</Button>
      {sets && sets.length === 0 ? <p className="empty">{PG5.emptySets}</p> : null}
      <ul className="rows">
        {sets?.map((s) => (
          <ListRow
            key={s.id}
            title={s.name}
            href={hrefOf(`/evals/${s.id}`)}
            selected={s.id === routeId}
            status={<span className="numeric row-count">{s.caseCount}</span>}
            menuLabel={MISSING_COPY.rowMenu}
            menu={[{ label: CP.delete, danger: true, onSelect: () => setDeleting(s) }]}
          />
        ))}
      </ul>
    </>
  );

  const caseColumns: Column<EvalCase>[] = [
    { key: "name", header: PG5.columns.name, render: (c) => c.name },
    { key: "kind", header: PG5.columns.kind, render: (c) => PG5.kinds[c.kind] },
    { key: "grader", header: PG5.columns.grader, render: graderLabel },
    { key: "tags", header: PG5.columns.tags, render: (c) => c.tags.join(", ") },
    {
      key: "actions",
      header: PG5_MISSING.actions,
      numeric: true,
      render: (c) => {
        const index = draft.cases.indexOf(c);
        return (
          <span className="case-actions" onClick={(e) => e.stopPropagation()}>
            <IconButton label={PG5_MISSING.moveUp} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp aria-hidden /></IconButton>
            <IconButton label={PG5_MISSING.moveDown} disabled={index === draft.cases.length - 1} onClick={() => move(index, 1)}><ArrowDown aria-hidden /></IconButton>
            <IconButton label={CP.delete} onClick={() => setCases(draft.cases.filter((x) => x !== c))}><Trash2 aria-hidden /></IconButton>
          </span>
        );
      },
    },
  ];

  const runColumns: Column<RunItem>[] = [
    { key: "date", header: PG5_MISSING.runDate, render: (r) => <span className="numeric">{dateText(r.createdAt)}</span> },
    { key: "preset", header: PG5_MISSING.runPreset, render: (r) => r.presetName },
    { key: "status", header: PG5_MISSING.runPassRate, numeric: true, render: (r) => (r.status === "completed" || r.passRate !== null ? percentText(r.passRate) : PG5_MISSING.runStatus[r.status]) },
    {
      key: "compare",
      header: PG5.compare,
      numeric: true,
      render: (r) =>
        r.status === "completed" ? (
          <Button size="sm" onClick={(e) => { e.stopPropagation(); setPendingCompare(r.evalSetId, r.id); navigate(`/evals/${r.evalSetId}/compare`); }}>{PG5.compare}</Button>
        ) : null,
    },
  ];

  const ready = creating || saved !== null;
  return (
    <ManageLayout list={list}>
      <h1 className="sr-only">{CP.nav.evals}</h1>
      {ready ? (
        <div className="eval-main">
          <div className="eval-head">
            <div className="eval-title">
              <span className="eval-name">{creating ? draft.name || PG5.newSet : saved!.name}</span>
              {!creating ? <span className="numeric eval-count">{saved!.cases.length}</span> : null}
            </div>
            {!creating ? (
              <div className="eval-head-actions">
                <Button variant="primary" loading={busy} disabled={saved!.cases.length === 0 && draft.cases.length === 0} onClick={() => void startRun()}>{PG5.run}</Button>
                <Button variant="danger" onClick={() => setDeleting(sets?.find((s) => s.id === saved!.id) ?? null)}>{CP.delete}</Button>
              </div>
            ) : null}
          </div>

          <form className="eval-set-form" onSubmit={(e) => { e.preventDefault(); if (draft.name.trim()) void save(); }}>
            <TextField label={PG5_MISSING.setName} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <TextField label={PG5_MISSING.description} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            <div className="eval-dir">
              <TextField label={PG5_MISSING.fixturesDir} value={draft.fixturesDir} onChange={(e) => setDraft({ ...draft, fixturesDir: e.target.value })} spellCheck={false} />
              <Button onClick={() => void choosePath()}>{PG5_MISSING.pickFolder}</Button>
            </div>
            <Button type="submit" disabled={busy || !draft.name.trim() || (!creating && !dirty)}>{CP.save}</Button>
          </form>
          {error ? <p className="field-error" role="alert">{error}</p> : null}

          {!creating ? (
            <>
              <div className="eval-tools">
                <Button onClick={() => void startImport()}>{PG5.import}</Button>
                <Button onClick={() => void exportFile()}>{PG5.export}</Button>
                <Button onClick={() => setEditing({ index: null })}>{PG5.addCase}</Button>
              </div>
              {importErrors.length ? (
                <div className="import-errors">
                  <p className="field-error" role="alert">{PG5.importFailed(importErrors.length)}</p>
                  <ul className="import-error-list">
                    {importErrors.map((e) => <li key={`${e.line}-${e.reason}`}><span className="numeric">{e.line}</span>：{e.reason}</li>)}
                  </ul>
                </div>
              ) : null}
              <Table
                columns={caseColumns}
                rows={draft.cases}
                rowKey={(c) => c.id ?? c.name}
                onRowClick={(c) => setEditing({ index: draft.cases.indexOf(c) })}
                caption={PG5.columns.name}
                empty={PG5.emptyCases}
              />
              <section className="eval-runs">
                <h2 className="section-title">{PG5.recentRuns}</h2>
                <Table columns={runColumns} rows={runs} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/runs/${r.id}`)} caption={PG5.recentRuns} empty={PG5.emptyRuns} />
              </section>
            </>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <CaseDialog
          key={editing.index ?? "new"}
          item={editing.index === null ? null : draft.cases[editing.index]}
          taken={draft.cases.filter((_, i) => i !== editing.index).map((c) => c.name)}
          onClose={() => setEditing(null)}
          onSave={(item) => {
            setCases(editing.index === null ? [...draft.cases, item] : draft.cases.map((c, i) => (i === editing.index ? item : c)));
            setEditing(null);
          }}
        />
      ) : null}
      {running && saved ? <RunDialog setId={saved.id} tags={tags} onClose={() => setRunning(false)} /> : null}
      {duplicateFor ? (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setDuplicateFor(null); }}
          title={PG5.duplicateTitle}
          footer={
            <>
              <Button onClick={() => setDuplicateFor(null)}>{CP.cancel}</Button>
              <Button onClick={() => { const f = duplicateFor; setDuplicateFor(null); void importFile("skip", f); }}>{PG5.skip}</Button>
              <Button variant="primary" onClick={() => { const f = duplicateFor; setDuplicateFor(null); void importFile("overwrite", f); }}>{PG5.overwrite}</Button>
            </>
          }
        />
      ) : null}
      {deleting ? (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setDeleting(null); }}
          title={PG5.confirmDelete(deleting.name)}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>{CP.cancel}</Button>
              <Button variant="danger" onClick={() => void removeSet(deleting)}>{CP.delete}</Button>
            </>
          }
        />
      ) : null}
    </ManageLayout>
  );
}
