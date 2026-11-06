import { Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/Button";
import { SwitchField } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { IconButton } from "../../components/IconButton";
import { Table, type Column } from "../../components/Table";
import { CP } from "../../copy";
import { pickFile } from "../../platform";
import { PG3 } from "./copy";
import { ErrorLine } from "./ErrorLine";
import { errorMessage, formatBytes } from "./format";
import { RegisterDialog } from "./RegisterDialog";
import type { AdapterItem, ModelItem } from "./types";

type Row = (ModelItem | AdapterItem) & { kind: "model" | "adapter" };

interface Props {
  kind: "model" | "adapter";
  models: ModelItem[];
  adapters: AdapterItem[];
  onChanged(): void;
}

/** 手元のモデル / LoRA の表（SEC-003-02）。登録は CP-084、削除は CP-098 */
export function LocalTab({ kind, models, adapters, onChanged }: Props) {
  const [picked, setPicked] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [alsoFile, setAlsoFile] = useState(false);
  const [error, setError] = useState("");

  async function pick() {
    const path = await pickFile();
    if (path) setPicked(path);
  }

  async function remove(row: Row) {
    setError("");
    try {
      await api.delete(`/${row.kind === "model" ? "models" : "adapters"}/${row.id}${alsoFile ? "?deleteFile=true" : ""}`);
      setDeleting(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const place = (row: Row) => (row.source === "local_ref" ? PG3.place.reference : PG3.place.store);
  const status = (row: Row) => (row.missing ? PG3.fileMissing : "");
  const del: Column<Row> = {
    key: "delete",
    header: "",
    render: (row) => (
      <IconButton label={CP.delete} onClick={() => { setError(""); setAlsoFile(false); setDeleting(row); }}><Trash2 aria-hidden /></IconButton>
    ),
  };
  const baseName = (row: Row) => models.find((m) => m.id === (row as AdapterItem).baseModelId)?.name ?? "";

  const columns: Column<Row>[] = kind === "model"
    ? [
        { key: "name", header: PG3.columns.name, render: (r) => r.name },
        { key: "quant", header: PG3.columns.quantization, render: (r) => (r as ModelItem).quantization ?? "" },
        { key: "size", header: PG3.columns.size, numeric: true, render: (r) => formatBytes((r as ModelItem).sizeBytes) },
        { key: "place", header: PG3.columns.place, render: place },
        { key: "status", header: PG3.columns.status, render: (r) => <span className={r.missing ? "models-missing" : undefined}>{status(r)}</span> },
        del,
      ]
    : [
        { key: "name", header: PG3.columns.name, render: (r) => r.name },
        { key: "base", header: PG3.baseModel, render: baseName },
        { key: "place", header: PG3.columns.place, render: place },
        { key: "status", header: PG3.columns.status, render: (r) => <span className={r.missing ? "models-missing" : undefined}>{status(r)}</span> },
        del,
      ];
  const rows: Row[] = kind === "model"
    ? models.map((m) => ({ ...m, kind: "model" as const }))
    : adapters.map((a) => ({ ...a, kind: "adapter" as const }));

  return (
    <>
      <div className="models-toolbar">
        <Button variant="primary" onClick={() => void pick()}>{PG3.register}</Button>
      </div>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        caption={kind === "model" ? PG3.tabModels : PG3.tabAdapters}
        empty={kind === "model" ? PG3.emptyModels : PG3.emptyAdapters}
      />
      {picked ? (
        <RegisterDialog kind={kind} path={picked} models={models} onClose={() => setPicked(null)} onDone={() => { setPicked(null); onChanged(); }} />
      ) : null}
      {deleting ? (
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
