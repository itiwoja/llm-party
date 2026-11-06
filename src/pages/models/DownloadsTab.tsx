import { useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/Button";
import { ProgressBar } from "../../components/ProgressBar";
import { Table, type Column } from "../../components/Table";
import { MISSING_COPY } from "../../copy";
import { PG3 } from "./copy";
import { ErrorLine } from "./ErrorLine";
import { errorMessage, formatBytes, formatEta } from "./format";
import { RegisterDialog } from "./RegisterDialog";
import type { AdapterItem, DownloadItem, ModelItem } from "./types";
import { isActive } from "./types";

interface Props {
  items: DownloadItem[];
  etaSeconds(item: DownloadItem): number | null;
  models: ModelItem[];
  adapters: AdapterItem[];
  onChanged(): void;
}

/** DL の表（API-056）。取り消し・再開（API-057）。完了した LoRA は参照で登録する */
export function DownloadsTab({ items, etaSeconds, models, adapters, onChanged }: Props) {
  const [registering, setRegistering] = useState<DownloadItem | null>(null);
  const [error, setError] = useState("");

  async function act(item: DownloadItem, action: "cancel" | "resume") {
    setError("");
    try {
      await api.post(`/downloads/${item.id}/${action}`);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const columns: Column<DownloadItem>[] = [
    {
      key: "name",
      header: PG3.columns.name,
      render: (d) => <span className="numeric">{d.repo}/{d.files[0]?.name}</span>,
    },
    { key: "size", header: PG3.columns.size, numeric: true, render: (d) => formatBytes(d.totalBytes ?? d.files.reduce((sum, f) => sum + f.sizeBytes, 0)) },
    {
      key: "status",
      header: PG3.columns.status,
      render: (d) => {
        const eta = etaSeconds(d);
        return (
          <div className="models-dl-status">
            <span>{PG3.downloadStatus[d.status]}</span>
            {d.status === "downloading" && d.totalBytes ? (
              <ProgressBar value={(d.receivedBytes / d.totalBytes) * 100} detail={eta === null ? undefined : formatEta(eta)} unknownLabel={MISSING_COPY.engineStarting} label={PG3.tabDownloads} />
            ) : null}
            {d.status === "failed" && d.error ? <span className="models-missing">{d.error}</span> : null}
          </div>
        );
      },
    },
    {
      key: "actions",
      header: "",
      render: (d) => (
        <div className="models-actions">
          {d.status === "failed" ? <Button size="sm" onClick={() => void act(d, "resume")}>{PG3.resume}</Button> : null}
          {isActive(d.status) || d.status === "failed" ? <Button size="sm" onClick={() => void act(d, "cancel")}>{PG3.cancelDownload}</Button> : null}
          {d.kind === "adapter" && d.status === "completed" && d.filePath && !adapters.some((a) => a.path === d.filePath) ? (
            <Button size="sm" onClick={() => setRegistering(d)}>{PG3.register}</Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      {error ? <ErrorLine message={error} /> : null}
      <Table columns={columns} rows={items} rowKey={(d) => d.id} caption={PG3.tabDownloads} empty={PG3.emptyDownloads} />
      {registering?.filePath ? (
        <RegisterDialog kind="adapter" path={registering.filePath} fixedReference models={models} onClose={() => setRegistering(null)} onDone={() => { setRegistering(null); onChanged(); }} />
      ) : null}
    </>
  );
}
