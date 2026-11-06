import { Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/Button";
import { SwitchField } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { IconButton } from "../../components/IconButton";
import { ProgressBar } from "../../components/ProgressBar";
import { Table, type Column } from "../../components/Table";
import { CP, MISSING_COPY } from "../../copy";
import { pickFile } from "../../platform";
import { PG3, PG3_MISSING } from "./copy";
import { ErrorLine } from "./ErrorLine";
import { errorMessage, formatBytes, formatEta } from "./format";
import { RegisterDialog } from "./RegisterDialog";
import type { AdapterItem, DownloadItem, ModelItem } from "./types";
import { isActive } from "./types";

type Row =
  | (ModelItem & { kind: "model" })
  | (AdapterItem & { kind: "adapter" })
  | { kind: "download"; download: DownloadItem };

interface Props {
  kind: "model" | "adapter";
  models: ModelItem[];
  adapters: AdapterItem[];
  /** 登録済みでない DL を、同じ表に出す（モデルは「手元のモデル」、LoRA は「LoRA」） */
  downloads: DownloadItem[];
  etaSeconds(item: DownloadItem): number | null;
  onChanged(): void;
}

const downloadName = (d: DownloadItem) => (d.kind === "file" && d.files.length > 1 ? `${d.repo}（${PG3_MISSING.fileCount(d.files.length)}）` : `${d.repo}/${d.files[0]?.name}`);
const downloadSize = (d: DownloadItem) => d.totalBytes ?? d.files.reduce((sum, f) => sum + f.sizeBytes, 0);

/** 手元のモデル / LoRA の表（SEC-003-02）。登録は CP-084、削除は CP-098。DL の行もここに出す（取り消し・再開は API-057） */
export function LocalTab({ kind, models, adapters, downloads, etaSeconds, onChanged }: Props) {
  const [picked, setPicked] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [registering, setRegistering] = useState<DownloadItem | null>(null);
  const [alsoFile, setAlsoFile] = useState(false);
  const [error, setError] = useState("");

  async function pick() {
    const path = await pickFile();
    if (path) setPicked(path);
  }

  async function remove(row: Row) {
    if (row.kind === "download") return;
    setError("");
    try {
      await api.delete(`/${row.kind === "model" ? "models" : "adapters"}/${row.id}${alsoFile ? "?deleteFile=true" : ""}`);
      setDeleting(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function act(item: DownloadItem, action: "cancel" | "resume") {
    setError("");
    try {
      await api.post(`/downloads/${item.id}/${action}`);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // 登録済みのモデルの DL（completed で resultId あり）は、手元のモデルの行と重なるので出さない。LoRA の DL は完了後も登録まで残す
  const shown = downloads.filter((d) => (kind === "adapter" ? d.kind === "adapter" : d.kind !== "adapter" && !(d.status === "completed" && d.kind !== "file")));

  const rows: Row[] = [
    ...(kind === "model" ? models.map((m) => ({ ...m, kind: "model" as const })) : adapters.map((a) => ({ ...a, kind: "adapter" as const }))),
    ...shown.map((download) => ({ kind: "download" as const, download })),
  ];

  const place = (row: Row) => {
    if (row.kind === "download") return row.download.savedDir ? PG3_MISSING.savedTo : "";
    return row.source === "local_ref" ? PG3.place.reference : PG3.place.store;
  };
  const baseName = (row: Row) => (row.kind === "adapter" ? models.find((m) => m.id === row.baseModelId)?.name ?? "" : "");

  const statusCell = (row: Row) => {
    if (row.kind !== "download") return <span className={row.missing ? "models-missing" : undefined}>{row.missing ? PG3.fileMissing : ""}</span>;
    const d = row.download;
    const eta = etaSeconds(d);
    return (
      <div className="models-dl-status">
        <span>{PG3.downloadStatus[d.status]}</span>
        {d.status === "downloading" && d.totalBytes ? (
          <ProgressBar value={(d.receivedBytes / d.totalBytes) * 100} detail={eta === null ? undefined : formatEta(eta)} unknownLabel={MISSING_COPY.engineStarting} label={PG3.tabDownloads} />
        ) : null}
        {d.status === "failed" && d.error ? <span className="models-missing">{d.error}</span> : null}
        {d.savedDir ? <span className="models-path numeric">{PG3_MISSING.savedTo} {d.savedDir}</span> : null}
      </div>
    );
  };

  const actionCell = (row: Row) => {
    if (row.kind !== "download") {
      return <IconButton label={CP.delete} onClick={() => { setError(""); setAlsoFile(false); setDeleting(row); }}><Trash2 aria-hidden /></IconButton>;
    }
    const d = row.download;
    return (
      <div className="models-actions">
        {d.status === "failed" ? <Button size="sm" onClick={() => void act(d, "resume")}>{PG3.resume}</Button> : null}
        {isActive(d.status) || d.status === "failed" ? <Button size="sm" onClick={() => void act(d, "cancel")}>{PG3.cancelDownload}</Button> : null}
        {d.kind === "adapter" && d.status === "completed" && d.filePath && !adapters.some((a) => a.path === d.filePath) ? (
          <Button size="sm" onClick={() => setRegistering(d)}>{PG3.register}</Button>
        ) : null}
      </div>
    );
  };

  const name = (row: Row) => (row.kind === "download" ? downloadName(row.download) : row.name);
  const size = (row: Row) => (row.kind === "download" ? downloadSize(row.download) : row.kind === "model" ? row.sizeBytes : 0);

  const columns: Column<Row>[] = kind === "model"
    ? [
        { key: "name", header: PG3.columns.name, render: (r) => <span className={r.kind === "download" ? "numeric" : undefined}>{name(r)}</span> },
        { key: "quant", header: PG3.columns.quantization, render: (r) => (r.kind === "model" ? r.quantization ?? "" : "") },
        { key: "size", header: PG3.columns.size, numeric: true, render: (r) => formatBytes(size(r)) },
        { key: "place", header: PG3.columns.place, render: place },
        { key: "status", header: PG3.columns.status, render: statusCell },
        { key: "actions", header: "", render: actionCell },
      ]
    : [
        { key: "name", header: PG3.columns.name, render: name },
        { key: "base", header: PG3.baseModel, render: baseName },
        { key: "place", header: PG3.columns.place, render: place },
        { key: "status", header: PG3.columns.status, render: statusCell },
        { key: "actions", header: "", render: actionCell },
      ];

  return (
    <>
      <div className="models-toolbar">
        <Button variant="primary" onClick={() => void pick()}>{PG3.register}</Button>
      </div>
      {error ? <ErrorLine message={error} /> : null}
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => (r.kind === "download" ? `dl-${r.download.id}` : r.id)}
        caption={kind === "model" ? PG3.tabModels : PG3.tabAdapters}
        empty={kind === "model" ? PG3.emptyModels : PG3.emptyAdapters}
      />
      {picked ? (
        <RegisterDialog kind={kind} path={picked} models={models} onClose={() => setPicked(null)} onDone={() => { setPicked(null); onChanged(); }} />
      ) : null}
      {registering?.filePath ? (
        <RegisterDialog kind="adapter" path={registering.filePath} fixedReference models={models} onClose={() => setRegistering(null)} onDone={() => { setRegistering(null); onChanged(); }} />
      ) : null}
      {deleting && deleting.kind !== "download" ? (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setDeleting(null); }}
          title={PG3.confirmDelete(deleting.name)}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>{CP.cancel}</Button>
              <Button variant="danger" onClick={() => void remove(deleting)}>{CP.delete}</Button>
            </>
          }
        >
          <div className="dialog-form">
            {deleting.source === "local_ref" ? null : <SwitchField label={PG3.deleteFile} checked={alsoFile} onCheckedChange={setAlsoFile} />}
            {error ? <ErrorLine message={error} /> : null}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
