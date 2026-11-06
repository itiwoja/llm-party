import { useState, type ReactNode } from "react";
import { api, ApiRequestError } from "../../api";
import { Button } from "../../components/Button";
import { RadioField } from "../../components/Controls";
import { SearchField } from "../../components/SearchField";
import { Table, type Column } from "../../components/Table";
import { MISSING_COPY } from "../../copy";
import { hrefOf } from "../../router";
import { PG3, PG3_MISSING } from "./copy";
import { ErrorLine } from "./ErrorLine";
import { errorMessage, formatBytes, formatDate } from "./format";
import type { HfFile, HfRepo } from "./types";

/** 401 は設定の HF トークンへ案内する（CP-096） */
export function hfFailure(err: unknown): ReactNode {
  if (err instanceof ApiRequestError && err.code === "AUTH_REQUIRED_UPSTREAM") {
    return <ErrorLine message={PG3.gated}> <a href={hrefOf("/settings")}>{PG3_MISSING.linkToSettings}</a></ErrorLine>;
  }
  return <ErrorLine message={errorMessage(err)} />;
}

/** Hugging Face を探す（API-053〜055）。検索は Enter で送る */
export function HfTab({ onStarted }: { onStarted(): void }) {
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<HfRepo[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);
  const [files, setFiles] = useState<HfFile[] | null>(null);
  const [kind, setKind] = useState<"model" | "adapter">("model");
  const [starting, setStarting] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  async function search() {
    const q = query.trim();
    if (!q) return;
    setFailure(null);
    setRepo(null);
    setFiles(null);
    setSearching(true);
    try {
      setRepos((await api.get<{ items: HfRepo[] }>(`/hf/search?q=${encodeURIComponent(q)}`)).items);
    } catch (err) {
      setFailure(err);
    } finally {
      setSearching(false);
    }
  }

  async function open(row: HfRepo) {
    setFailure(null);
    setRepo(row.repo);
    setFiles(null);
    try {
      setFiles((await api.get<{ items: HfFile[] }>(`/hf/files?repo=${encodeURIComponent(row.repo)}`)).items);
    } catch (err) {
      setFailure(err);
    }
  }

  async function start(file: HfFile) {
    if (!repo) return;
    setFailure(null);
    setStarting(file.name);
    try {
      await api("/downloads", { repo, files: [file.name], kind });
      onStarted();
    } catch (err) {
      setFailure(err);
    } finally {
      setStarting(null);
    }
  }

  const repoColumns: Column<HfRepo>[] = [
    { key: "repo", header: PG3_MISSING.colRepo, render: (r) => <button type="button" className="link-btn numeric">{r.repo}</button> },
    { key: "downloads", header: PG3_MISSING.colDownloads, numeric: true, render: (r) => r.downloads.toLocaleString("en-US") },
    // updatedAt が null（HF が lastModified を返さない）ときは空にする。createdAt は出さない
    { key: "updated", header: PG3_MISSING.colUpdated, numeric: true, render: (r) => formatDate(r.updatedAt) },
  ];
  const fileColumns: Column<HfFile>[] = [
    { key: "file", header: PG3_MISSING.colFile, render: (f) => <span className="numeric">{f.name}</span> },
    { key: "quant", header: PG3.columns.quantization, render: (f) => f.quantization ?? "" },
    { key: "size", header: PG3.columns.size, numeric: true, render: (f) => formatBytes(f.sizeBytes) },
    {
      key: "dl",
      header: "",
      render: (f) => (
        <Button size="sm" loading={starting === f.name} disabled={!f.complete || starting !== null} title={f.complete ? undefined : PG3_MISSING.incomplete} onClick={() => void start(f)}>
          {PG3.download}
        </Button>
      ),
    },
  ];

  return (
    <>
      <form className="models-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <SearchField value={query} onChange={setQuery} label={PG3.searchRepo} clearLabel={MISSING_COPY.clearSearch} />
      </form>
      {failure ? hfFailure(failure) : null}
      {repos && !searching ? (
        <Table columns={repoColumns} rows={repos} rowKey={(r) => r.repo} caption={PG3.tabHf} empty={PG3.emptySearch} onRowClick={(r) => void open(r)} />
      ) : null}
      {repo ? (
        <section className="models-files">
          <p className="models-path numeric">{repo}</p>
          <RadioField
            label={PG3.tabDownloads}
            value={kind}
            onValueChange={(v) => setKind(v as "model" | "adapter")}
            options={[{ value: "model", label: PG3.tabModels }, { value: "adapter", label: PG3.tabAdapters }]}
          />
          {files ? <Table columns={fileColumns} rows={files} rowKey={(f) => f.name} caption={repo} empty={PG3.emptySearch} /> : null}
        </section>
      ) : null}
    </>
  );
}
