import { ArrowDownRight, ArrowLeft, ArrowUpRight, Equal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { SelectField } from "../../components/Controls";
import { Table, type Column } from "../../components/Table";
import { CP } from "../../copy";
import { MeasureLayout } from "../../layouts";
import { hrefOf, useRoute } from "../../router";
import type { EvalSetFull, RunItem } from "../evals/types";
import { PG6 } from "../runs/copy";
import { dateText } from "../runs/format";
import { Metric } from "../runs/Metric";
import { PG7, PG7_MISSING } from "./copy";
import { LineChart, type Series } from "./LineChart";
import { takePendingCompare } from "./pick";
import { SideBySide, type Side } from "./SideBySide";
import "../runs/runs.css";
import "./compare.css";

type Change = "regressed" | "improved" | "same";
interface CaseRow { caseName: string; caseId: string | null; change: Change; a: Side; b: Side }
interface Trend { series: Series[]; runs?: RunItem[]; cases?: CaseRow[] }

const CHANGE_ICON = { regressed: ArrowDownRight, improved: ArrowUpRight, same: Equal } as const;
const FAILING = new Set(["failed", "timed_out", "error"]);

/** ○ × 点数 など、1 ケースの結果の印（CP-159） */
function mark(side: Side): string {
  if (side.score !== null) return String(side.score);
  if (side.status === "passed") return PG6.marks.pass;
  if (FAILING.has(side.status)) return PG6.marks.fail;
  return PG6.status[side.status] ?? side.status;
}

/** 絞り込み中は、比べているケースだけで正解率を出し直す（server/eval/grade.ts の summarize と同じ数え方） */
function passRateOf(sides: Side[]): number | null {
  const judged = sides.filter((s) => !["needs_review", "skipped", "pending", "running"].includes(s.status));
  return judged.length ? judged.filter((s) => s.status === "passed").length / judged.length : null;
}

/** PG-007 比較・推移（計測の型。ルート #/evals/:id/compare）。主ボタンなしの見る画面 */
export function ComparePage() {
  const route = useRoute();
  const setId = route.page === "compare" ? route.id : "";
  const [set, setSet] = useState<EvalSetFull | null>(null);
  const [runs, setRuns] = useState<RunItem[] | null>(null);
  const [aId, setAId] = useState("");
  const [bId, setBId] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [openCase, setOpenCase] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRuns(null);
    setSet(null);
    const wanted = takePendingCompare(setId);
    void Promise.all([api.get<EvalSetFull>(`/eval-sets/${setId}`), api.get<{ items: RunItem[] }>(`/eval-runs?evalSetId=${setId}`)])
      .then(([full, list]) => {
        const done = list.items.filter((r) => r.status === "completed");
        const b = done.find((r) => r.id === wanted) ?? done[0];
        // 新しい順なので、B の次にある完了済みが 1 つ前のラン
        const a = b ? done[done.indexOf(b) + 1] ?? done.find((r) => r.id !== b.id) : undefined;
        setSet(full);
        setRuns(done);
        setAId(a?.id ?? "");
        setBId(b?.id ?? "");
      })
      .catch(() => setRuns([]));
  }, [setId]);

  useEffect(() => {
    if (!runs || runs.length < 2) return;
    const query = [
      tags.length ? `tags=${encodeURIComponent(tags.join(","))}` : "",
      aId && bId && aId !== bId ? `compare=${aId},${bId}` : "",
    ].filter(Boolean).join("&");
    void api.get<Trend>(`/eval-sets/${setId}/trend${query ? `?${query}` : ""}`).then(setTrend).catch(() => setTrend(null));
  }, [setId, runs, aId, bId, tags]);

  useEffect(() => {
    if (openCase) detailRef.current?.scrollIntoView({ block: "nearest" });
  }, [openCase]);

  const allTags = useMemo(() => [...new Set((set?.cases ?? []).flatMap((c) => c.tags))].sort(), [set]);
  const runA = runs?.find((r) => r.id === aId);
  const runB = runs?.find((r) => r.id === bId);
  const cases = trend?.cases ?? [];
  const count = (change: Change) => cases.filter((c) => c.change === change).length;
  const open = cases.find((c) => c.caseName === openCase) ?? null;

  const rateA = tags.length ? passRateOf(cases.map((c) => c.a)) : runA?.passRate ?? null;
  const rateB = tags.length ? passRateOf(cases.map((c) => c.b)) : runB?.passRate ?? null;
  const speedDelta = runA?.avgTokensPerSec != null && runB?.avgTokensPerSec != null ? runB.avgTokensPerSec - runA.avgTokensPerSec : null;
  const rateDelta = rateA !== null && rateB !== null ? (rateB - rateA) * 100 : null;

  const runOptions = (runs ?? []).map((r) => ({ value: r.id, label: `${r.presetName} ${dateText(r.createdAt)}` }));

  const columns: Column<CaseRow>[] = [
    {
      key: "change",
      header: PG7_MISSING.changeColumn,
      render: (c) => {
        const Icon = CHANGE_ICON[c.change];
        return <span className={`change change-${c.change}`}><Icon aria-hidden />{PG7.change[c.change]}</span>;
      },
    },
    { key: "case", header: PG6.columns.case, render: (c) => c.caseName },
    { key: "result", header: PG6.columns.result, numeric: true, render: (c) => <span className="numeric">{mark(c.a)}→{mark(c.b)}</span> },
  ];

  const body = () => {
    if (runs === null) return null;
    if (runs.length < 2) return <p className="empty">{PG7.empty}</p>;
    return (
      <div className="compare">
        <div className="compare-left">
          <div className="compare-pick">
            <SelectField label={PG7.runA} value={aId} onValueChange={setAId} options={runOptions} />
            <SelectField label={PG7.runB} value={bId} onValueChange={setBId} options={runOptions} />
          </div>
          <div className="compare-metrics">
            <Metric
              large
              label={PG6.passRate}
              value={rateB === null ? null : rateB * 100}
              format={(v) => `${v.toFixed(1)}%`}
              delta={rateDelta === null ? null : { value: rateDelta, format: (v) => Math.abs(v).toFixed(1) }}
            />
            <Metric
              label={PG6.avgSpeed}
              value={runB?.avgTokensPerSec ?? null}
              format={(v) => v.toFixed(1)}
              delta={speedDelta === null ? null : { value: speedDelta, format: (v) => Math.abs(v).toFixed(1) }}
            />
          </div>
          <p className="compare-counts numeric">
            <span className="change change-improved"><ArrowUpRight aria-hidden />{PG7.improved(count("improved"))}</span>
            <span className="change change-regressed"><ArrowDownRight aria-hidden />{PG7.regressed(count("regressed"))}</span>
            <span className="change change-same"><Equal aria-hidden />{PG7.same(count("same"))}</span>
          </p>
          {allTags.length ? (
            <fieldset className="tag-fieldset">
              <legend className="field-label">{PG7.tagFilter}</legend>
              <div className="checks checks-row">
                {allTags.map((tag) => (
                  <label key={tag} className="check">
                    <input type="checkbox" checked={tags.includes(tag)} onChange={(e) => setTags(e.target.checked ? [...tags, tag] : tags.filter((t) => t !== tag))} />
                    <span>{tag}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <h2 className="section-title">{PG7.trend}</h2>
          {trend && trend.series.length ? <LineChart series={trend.series} focus={runB?.presetName ?? null} /> : null}
        </div>
        <div className="compare-right">
          <Table columns={columns} rows={cases} rowKey={(c) => c.caseName} onRowClick={(c) => setOpenCase(c.caseName === openCase ? null : c.caseName)} caption={PG7.trend} empty={PG7_MISSING.noCases} />
        </div>
        {open ? <div className="compare-detail" ref={detailRef}><SideBySide caseName={open.caseName} a={open.a} b={open.b} onClose={() => setOpenCase(null)} /></div> : null}
      </div>
    );
  };

  return (
    <MeasureLayout>
      <h1 className="sr-only">{CP.nav.evals}</h1>
      <div className="run-head">
        <a className="run-back" href={hrefOf(`/evals/${setId}`)}><ArrowLeft aria-hidden />{set?.name ?? ""}</a>
      </div>
      {body()}
    </MeasureLayout>
  );
}
