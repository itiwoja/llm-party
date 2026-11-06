import { ArrowLeft, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { useServerEvent } from "../../app-data";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { IconButton } from "../../components/IconButton";
import { SelectField } from "../../components/Controls";
import { ProgressBar } from "../../components/ProgressBar";
import { Table, type Column } from "../../components/Table";
import { CP } from "../../copy";
import { MeasureLayout } from "../../layouts";
import { hrefOf, navigate, useRoute } from "../../router";
import { PG6, PG6_MISSING } from "./copy";
import { setPendingCompare } from "../compare/pick";
import type { EvalSetFull, ResultItem, RunItem } from "../evals/types";
import { clockText, dateText, secondsText, speedText } from "./format";
import { Metric } from "./Metric";
import { StatusMark } from "./StatusMark";
import { ResultBody } from "./ResultBody";
import "./runs.css";

type Grader = EvalSetFull["cases"][number]["grader"];

/** 人手採点（pass_fail は ○×、1to5 は点数）。付け直しもできる */
function GradeControls({ result, grader, busy, onGrade }: { result: ResultItem; grader: Grader | undefined; busy: boolean; onGrade(body: { verdict: "passed" | "failed" } | { score: number }): void }) {
  const scale = grader?.type === "manual" ? grader.scale : "pass_fail";
  return (
    <span className="grade" role="group" aria-label={PG6_MISSING.grading} onClick={(e) => e.stopPropagation()}>
      {scale === "pass_fail" ? (
        <>
          <Button size="sm" aria-label={PG6.status.passed} aria-pressed={result.status === "passed"} variant={result.status === "passed" ? "primary" : "secondary"} disabled={busy} onClick={() => onGrade({ verdict: "passed" })}>{PG6.marks.pass}</Button>
          <Button size="sm" aria-label={PG6.status.failed} aria-pressed={result.status === "failed"} variant={result.status === "failed" ? "primary" : "secondary"} disabled={busy} onClick={() => onGrade({ verdict: "failed" })}>{PG6.marks.fail}</Button>
        </>
      ) : (
        [1, 2, 3, 4, 5].map((n) => (
          <Button key={n} size="sm" className="numeric" aria-pressed={result.score === n} variant={result.score === n ? "primary" : "secondary"} disabled={busy} onClick={() => onGrade({ score: n })}>{n}</Button>
        ))
      )}
    </span>
  );
}

/** PG-006 ラン結果（計測の型。ルート #/runs/:id） */
export function RunsPage() {
  const route = useRoute();
  const runId = route.page === "runs" ? route.id : "";
  const [run, setRun] = useState<RunItem | null>(null);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [set, setSet] = useState<EvalSetFull | null>(null);
  const [siblings, setSiblings] = useState<RunItem[]>([]);
  const [missing, setMissing] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);
  const [confirm, setConfirm] = useState<"cancel" | "delete" | null>(null);
  const [error, setError] = useState("");
  const detailRef = useRef<HTMLElement>(null);
  const setIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ run: RunItem; results: ResultItem[] }>(`/eval-runs/${runId}`);
      setRun(data.run);
      setResults(data.results);
      setMissing(false);
      if (setIdRef.current !== data.run.evalSetId) {
        setIdRef.current = data.run.evalSetId;
        const [full, list] = await Promise.all([
          api.get<EvalSetFull>(`/eval-sets/${data.run.evalSetId}`),
          api.get<{ items: RunItem[] }>(`/eval-runs?evalSetId=${data.run.evalSetId}`),
        ]);
        setSet(full);
        setSiblings(list.items);
      }
    } catch {
      setMissing(true);
    }
  }, [runId]);

  useEffect(() => {
    setRun(null);
    setResults([]);
    setOpenId(null);
    setError("");
    setIdRef.current = null;
    void load();
  }, [load]);

  // 進捗は eval.progress（API-099）。表は進むたびに引き直す
  useServerEvent((event) => {
    if ((event.event === "eval.progress" || event.event === "eval.finished") && event.data.runId === runId) void load();
  });

  const cases = useMemo(() => new Map(set?.cases.map((item) => [item.id, item]) ?? []), [set]);
  const active = run?.status === "queued" || run?.status === "running";
  const needsReview = results.filter((r) => r.status === "needs_review").length;
  const rows = reviewOnly ? results.filter((r) => r.status === "needs_review") : results;
  const open = results.find((r) => r.id === openId) ?? null;
  const openCase = open?.caseId ? cases.get(open.caseId) : undefined;

  useEffect(() => {
    if (openId) detailRef.current?.scrollIntoView({ block: "nearest" });
  }, [openId]);

  async function grade(result: ResultItem, body: { verdict: "passed" | "failed" } | { score: number }) {
    setGrading(true);
    setError("");
    try {
      await api.patch(`/eval-results/${result.id}`, body);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGrading(false);
    }
  }

  async function act(kind: "cancel" | "delete") {
    setError("");
    try {
      if (kind === "cancel") await api.post(`/eval-runs/${runId}/cancel`);
      else {
        await api.delete(`/eval-runs/${runId}`);
        navigate(`/evals/${run!.evalSetId}`, true);
        return;
      }
      setConfirm(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConfirm(null);
    }
  }

  function openCompare() {
    if (!run) return;
    setPendingCompare(run.evalSetId, run.id);
    navigate(`/evals/${run.evalSetId}/compare`);
  }

  if (missing) {
    return (
      <MeasureLayout>
        <h1 className="sr-only">{CP.nav.evals}</h1>
        <p className="empty">{PG6_MISSING.notFound}</p>
      </MeasureLayout>
    );
  }
  if (!run) {
    return (
      <MeasureLayout>
        <h1 className="sr-only">{CP.nav.evals}</h1>
      </MeasureLayout>
    );
  }

  const columns: Column<ResultItem>[] = [
    { key: "case", header: PG6.columns.case, render: (r) => r.caseName },
    {
      key: "result",
      header: PG6.columns.result,
      render: (r) => {
        const item = r.caseId ? cases.get(r.caseId) : undefined;
        return (
          <span className="result-cell">
            <StatusMark status={r.status} />
            {r.score !== null ? <span className="numeric">{r.score}</span> : null}
            {r.status === "needs_review" ? <GradeControls result={r} grader={item?.grader} busy={grading} onGrade={(body) => void grade(r, body)} /> : null}
          </span>
        );
      },
    },
    { key: "time", header: PG6.columns.time, numeric: true, render: (r) => secondsText(r.durationMs) },
    { key: "speed", header: PG6.columns.speed, numeric: true, render: (r) => speedText(r.tokensPerSec) },
  ];

  const runLabel = `${run.presetName} ${dateText(run.createdAt)}`;
  return (
    <MeasureLayout>
      <h1 className="sr-only">{CP.nav.evals}</h1>
      <div className="run-head">
        <a className="run-back" href={hrefOf(`/evals/${run.evalSetId}`)}><ArrowLeft aria-hidden />{set?.name ?? ""}</a>
        {siblings.length > 1 ? (
          <div className="run-pick">
            <SelectField
              label={PG6_MISSING.pickRun}
              hideLabel
              value={run.id}
              onValueChange={(id) => navigate(`/runs/${id}`)}
              options={siblings.map((s) => ({ value: s.id, label: `${s.presetName} ${dateText(s.createdAt)}` }))}
            />
          </div>
        ) : <span className="run-name">{runLabel}</span>}
        <div className="run-actions">
          <IconButton label={CP.delete} disabled={active} onClick={() => { setError(""); setConfirm("delete"); }}><Trash2 aria-hidden /></IconButton>
          {active ? (
            <Button variant="primary" onClick={() => setConfirm("cancel")}>{PG6.cancel}</Button>
          ) : (
            <Button variant="primary" onClick={openCompare}>{PG6.openCompare}</Button>
          )}
        </div>
      </div>

      <div className="metrics-row">
        <Metric large label={PG6.passRate} value={run.passRate === null ? null : run.passRate * 100} format={(v) => `${v.toFixed(1)}%`} />
        <Metric label={PG6.avgScore} value={run.avgScore} format={(v) => v.toFixed(1)} />
        <Metric label={PG6.avgSpeed} value={run.avgTokensPerSec} format={(v) => v.toFixed(1)} />
        <Metric label={PG6.totalTime} value={run.totalDurationMs || null} format={clockText} />
      </div>

      {active ? (
        <ProgressBar
          value={run.total ? (run.done / run.total) * 100 : null}
          detail={`${run.done}/${run.total}`}
          unknownLabel={PG6_MISSING.starting}
          label={PG6_MISSING.progress}
        />
      ) : null}
      {run.status === "failed" ? <p className="field-error" role="alert"><TriangleAlert aria-hidden />{PG6.runFailed}</p> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}

      {needsReview > 0 ? (
        <div className="table-tools">
          <Button size="sm" variant={reviewOnly ? "primary" : "secondary"} aria-pressed={reviewOnly} onClick={() => setReviewOnly((v) => !v)}>{PG6.reviewOnly}</Button>
        </div>
      ) : null}
      <Table columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id === openId ? null : r.id)} caption={run.presetName} />

      {open ? (
        <section className="result-detail" ref={detailRef} aria-label={open.caseName}>
          <div className="result-detail-head">
            <h2 className="result-title">{open.caseName}</h2>
            <StatusMark status={open.status} />
            {openCase?.grader.type === "manual" && (open.status !== "pending" && open.status !== "running" && open.status !== "skipped") ? (
              <GradeControls result={open} grader={openCase.grader} busy={grading} onGrade={(body) => void grade(open, body)} />
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setOpenId(null)}>{CP.close}</Button>
          </div>
          {openCase ? (
            <section>
              <h4 className="result-heading">{PG6.headings.input}</h4>
              <p className="result-input">{openCase.input}</p>
              {openCase.grader.type === "manual" && openCase.grader.rubric ? <p className="field-hint">{PG6_MISSING.rubric}：{openCase.grader.rubric}</p> : null}
            </section>
          ) : null}
          <ResultBody result={open} />
        </section>
      ) : null}

      {confirm ? (
        <Dialog
          open
          onOpenChange={(v) => { if (!v) setConfirm(null); }}
          title={confirm === "cancel" ? PG6.confirmCancel : PG6_MISSING.confirmDeleteRun(run.presetName)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>{CP.cancel}</Button>
              <Button variant="danger" onClick={() => void act(confirm)}>{confirm === "cancel" ? PG6.cancel : CP.delete}</Button>
            </>
          }
        />
      ) : null}
    </MeasureLayout>
  );
}
