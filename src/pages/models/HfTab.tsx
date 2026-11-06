import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiRequestError } from "../../api";
import { Button } from "../../components/Button";
import { RadioField, SelectField, SwitchField } from "../../components/Controls";
import { SearchField } from "../../components/SearchField";
import { Table, type Column } from "../../components/Table";
import { MISSING_COPY } from "../../copy";
import { hrefOf } from "../../router";
import { PG3, PG3_MISSING } from "./copy";
import { ErrorLine } from "./ErrorLine";
import { distinctLabels } from "./fileLabel";
import { errorMessage, formatBytes, formatDate } from "./format";
import type { HfFile, HfRepo } from "./types";


type Genre = keyof typeof PG3_MISSING.genres;
/** VRAM・RAM は GB の上限。null は指定なし */
interface Filters { query: string; genre: Genre; uncensored: boolean; vram: number | null; ram: number | null }

/** 入力欄の文字を GB にする。空や 0 以下は指定なし */
function parseGb(text: string): number | null {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
}
const gbText = (memoryGb: number) => `${memoryGb.toFixed(1)}GB`;

/** パラメータ数を「9B」「0.6B」「350M」にする */
function paramsText(params: number): string {
  return params >= 1e9 ? `${Number((params / 1e9).toFixed(1))}B` : `${Math.round(params / 1e6)}M`;
}

/** 強さ（パラメータ数）の大きい順。分からないものは末尾。同じなら DL 数の多い順 */
const byStrength = (a: HfRepo, b: HfRepo) => (b.params ?? -1) - (a.params ?? -1) || b.downloads - a.downloads;

/** 強さのバー。長さは結果の中で一番大きいモデルを 100% とする */
function StrengthBar({ params, max }: { params: number | null; max: number }) {
  if (params === null) return null;
  const percent = max > 0 ? (params / max) * 100 : 0;
  return (
    <span className="strength">
      <span className="strength-track" aria-hidden="true">
        <span className="strength-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="numeric models-nowrap">{paramsText(params)}</span>
    </span>
  );
}

const GENRE_OPTIONS = (Object.keys(PG3_MISSING.genres) as Genre[]).map((value) => ({ value, label: PG3_MISSING.genres[value] }));

/** pipeline_tag の表示名。ジャンルにない値はそのまま出す */
const PIPELINE_LABELS: Record<string, string> = {
  "text-generation": PG3_MISSING.genres.chat,
  "image-text-to-text": PG3_MISSING.genres.chat,
  "text-to-image": PG3_MISSING.genres.image,
  "text-to-video": PG3_MISSING.genres.video,
  "text-to-audio": PG3_MISSING.genres.music,
  "text-to-speech": PG3_MISSING.genres.speech,
  "automatic-speech-recognition": PG3_MISSING.genres.transcribe,
  "feature-extraction": PG3_MISSING.genres.embedding,
  "sentence-similarity": PG3_MISSING.genres.embedding,
};

/** チャットで動かせる見込みがあるか。pipeline_tag の無いリポジトリ（LoRA に多い）は今までどおり選ばせる */
const isChatRepo = (repo: HfRepo) => repo.pipelineTag === null || PIPELINE_LABELS[repo.pipelineTag] === PG3_MISSING.genres.chat;
const isGguf = (name: string) => name.toLowerCase().endsWith(".gguf");
const isImageRepo = (repo: HfRepo) => repo.pipelineTag !== null && PIPELINE_LABELS[repo.pipelineTag] === PG3_MISSING.genres.image;
/** 画像生成に登録できる形。分割していない単一の .safetensors */
const isImageFile = (name: string) => name.toLowerCase().endsWith(".safetensors") && !/-\d{5}-of-\d{5}\.safetensors$/i.test(name);
/** mmproj（画像の入力部）と imatrix（量子化の計算用）は、どのリポジトリでもモデル本体ではないので出さない */
const isAuxFile = (name: string) => /^(mmproj|imatrix)/i.test(name.split("/").pop() ?? name);
/** チャット用に出すのはモデル本体の GGUF だけ */
const isModelFile = (name: string) => isGguf(name) && !isAuxFile(name);
/** 保存だけのリポジトリに出すのはモデルの重みファイルだけ（README・設定の json・画像は出さない） */
const isWeightFile = (name: string) => /\.(gguf|safetensors|ckpt|pt|pth|bin|onnx)$/i.test(name) && !isAuxFile(name);

/** 401 は設定の HF トークンへ案内する（CP-096） */
export function hfFailure(err: unknown): ReactNode {
  if (err instanceof ApiRequestError && err.code === "AUTH_REQUIRED_UPSTREAM") {
    return <ErrorLine message={PG3.gated}> <a href={hrefOf("/settings")}>{PG3_MISSING.linkToSettings}</a></ErrorLine>;
  }
  return <ErrorLine message={errorMessage(err)} />;
}

/** Hugging Face を探す（API-053〜055）。語は Enter で送り、ジャンルと無検閲は変えた時点で探し直す */
export function HfTab({ onStarted }: { onStarted(): void }) {
  const [filters, setFilters] = useState<Filters>({ query: "", genre: "all", uncensored: false, vram: null, ram: null });
  // 数字の入力中は文字のまま持ち、欄を離れたか Enter で絞り込む
  const [memoryDraft, setMemoryDraft] = useState({ vram: "", ram: "" });
  const [repos, setRepos] = useState<HfRepo[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [repo, setRepo] = useState<HfRepo | null>(null);
  const [files, setFiles] = useState<HfFile[] | null>(null);
  const [kind, setKind] = useState<"model" | "adapter">("model");
  const [starting, setStarting] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  // ジャンルを続けて変えたとき、古い検索の結果で上書きしない
  const latestSearch = useRef(0);
  const filesRef = useRef<HTMLElement>(null);

  // ファイル一覧は長い表の下に開くので、開いたら見える所まで動かす。読み込み後は下に余白ができるのでもう一度動かす
  useEffect(() => {
    if (repo) filesRef.current?.scrollIntoView({ block: "start" });
  }, [repo, files]);

  async function search({ query, genre, uncensored, vram, ram }: Filters) {
    const q = query.trim();
    const id = (latestSearch.current += 1);
    setFailure(null);
    setRepo(null);
    setFiles(null);
    if (!q && genre === "all" && !uncensored && vram === null && ram === null) {
      setRepos(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ q, genre, uncensored: String(uncensored) });
      if (vram !== null) params.set("vram", String(vram));
      if (ram !== null) params.set("ram", String(ram));
      const { items } = await api.get<{ items: HfRepo[] }>(`/hf/search?${params}`);
      if (id === latestSearch.current) setRepos(items);
    } catch (err) {
      if (id === latestSearch.current) setFailure(err);
    } finally {
      if (id === latestSearch.current) setSearching(false);
    }
  }

  function refine(change: Partial<Filters>) {
    const next = { ...filters, ...change };
    setFilters(next);
    void search(next);
  }

  /** 欄を離れたとき。変わっていなければ探し直さない */
  function commitMemory(key: "vram" | "ram") {
    const value = parseGb(memoryDraft[key]);
    if (value !== filters[key]) refine({ [key]: value });
  }

  async function open(row: HfRepo) {
    setFailure(null);
    setRepo(row);
    setFiles(null);
    try {
      setFiles((await api.get<{ items: HfFile[] }>(`/hf/files?repo=${encodeURIComponent(row.repo)}`)).items);
    } catch (err) {
      setFailure(err);
    }
  }

  /** GGUF 以外とチャットで動かないモデルは保存だけにする */
  async function start(file: HfFile) {
    if (!repo) return;
    setFailure(null);
    setStarting(file.name);
    try {
      const saveOnly = !isGguf(file.name) || !isChatRepo(repo);
      const useKind = isImageRepo(repo) && isImageFile(file.name) ? "image" : saveOnly ? "file" : kind;
      await api("/downloads", { repo: repo.repo, files: [file.name], kind: useKind });
      onStarted();
    } catch (err) {
      setFailure(err);
    } finally {
      setStarting(null);
    }
  }

  // 強さ順に並べ直す（API は DL 数の順で返すので、ここで並べ替える）
  const ranked = repos ? [...repos].sort(byStrength) : [];
  const maxParams = Math.max(0, ...ranked.map((r) => r.params ?? 0));
  // チャットのリポジトリは GGUF のモデルだけを出し、リポジトリ全体の DL は出さない（全部取ると不要なファイルまで入る）。それ以外も重みだけを出す
  const chatRepo = repo !== null && isChatRepo(repo);
  // 強さ順（容量が大きいほど強い）に並べる。同じ容量は名前順
  const shownFiles = files
    ?.filter((f) => (chatRepo ? isModelFile(f.name) : isWeightFile(f.name)))
    .sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));

  const repoColumns: Column<HfRepo>[] = [
    { key: "repo", header: PG3_MISSING.colRepo, render: (r) => <button type="button" className="link-btn numeric">{r.repo}</button> },
    { key: "strength", header: PG3_MISSING.colStrength, render: (r) => <StrengthBar params={r.params} max={maxParams} /> },
    { key: "genre", header: PG3_MISSING.genre, render: (r) => <span className="models-nowrap">{r.pipelineTag ? PIPELINE_LABELS[r.pipelineTag] ?? r.pipelineTag : ""}</span> },
    { key: "license", header: PG3_MISSING.colLicense, render: (r) => <span className="numeric models-nowrap">{r.license ?? ""}</span> },
    { key: "memory", header: PG3_MISSING.colMemory, numeric: true, render: (r) => (r.memoryGb === null ? "" : gbText(r.memoryGb)) },
    { key: "downloads", header: PG3_MISSING.colDownloads, numeric: true, render: (r) => r.downloads.toLocaleString("en-US") },
    // updatedAt が null（HF が lastModified を返さない）ときは空にする。createdAt は出さない
    { key: "updated", header: PG3_MISSING.colUpdated, numeric: true, render: (r) => formatDate(r.updatedAt) },
  ];
  // ファイルごとの違う部分（同じ名前の並びでは共通部分を外して見せる）
  const labels = new Map((shownFiles ?? []).map((f, i, all) => [f.name, distinctLabels(all.map((x) => x.name))[i]]));
  const fileColumns: Column<HfFile>[] = [
    {
      key: "file",
      header: PG3_MISSING.colFile,
      render: (f) => (
        <span className="hf-file-name numeric" title={f.name}>
          <strong className="hf-file-label">{labels.get(f.name) ?? f.name}</strong>
          {labels.get(f.name) !== f.name ? <span className="hf-file-full">{f.name}</span> : null}
        </span>
      ),
    },
    { key: "quant", header: PG3.columns.quantization, render: (f) => f.quantization ?? "" },
    { key: "size", header: PG3.columns.size, numeric: true, render: (f) => formatBytes(f.sizeBytes) },
    { key: "memory", header: PG3_MISSING.colMemory, numeric: true, render: (f) => gbText(f.memoryGb) },
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
      <div className="models-filters">
        <SelectField label={PG3_MISSING.genre} hideLabel value={filters.genre} options={GENRE_OPTIONS} onValueChange={(v) => refine({ genre: v as Genre })} />
        <SwitchField label={PG3_MISSING.uncensored} checked={filters.uncensored} onCheckedChange={(uncensored) => refine({ uncensored })} />
        {(["vram", "ram"] as const).map((key) => (
          <label key={key} className="field models-memory">
            <span className="field-label">{key === "vram" ? PG3_MISSING.vram : PG3_MISSING.ram}</span>
            <input
              className="input numeric"
              type="number"
              inputMode="decimal"
              min="1"
              max="1024"
              step="any"
              value={memoryDraft[key]}
              onChange={(e) => setMemoryDraft((draft) => ({ ...draft, [key]: e.target.value }))}
              onBlur={() => commitMemory(key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitMemory(key);
              }}
            />
          </label>
        ))}
      </div>
      {filters.vram !== null || filters.ram !== null ? <p className="models-note">{PG3_MISSING.memoryHint}</p> : null}
      <form className="models-search" onSubmit={(e) => { e.preventDefault(); void search(filters); }}>
        <SearchField value={filters.query} onChange={(query) => setFilters((f) => ({ ...f, query }))} label={PG3.searchRepo} clearLabel={MISSING_COPY.clearSearch} />
      </form>
      {failure ? hfFailure(failure) : null}
      {repos && !searching ? (
        <>
          {ranked.length > 0 ? <p className="models-note">{PG3_MISSING.strengthHint}</p> : null}
          <Table columns={repoColumns} rows={ranked} rowKey={(r) => r.repo} caption={PG3.tabHf} empty={PG3.emptySearch} onRowClick={(r) => void open(r)} />
        </>
      ) : null}
      {repo ? (
        <section ref={filesRef} className="models-files">
          <p className="models-path numeric">{repo.repo}</p>
          {isChatRepo(repo) ? (
            <RadioField
              label={PG3.tabDownloads}
              value={kind}
              onValueChange={(v) => setKind(v as "model" | "adapter")}
              options={[{ value: "model", label: PG3.tabModels }, { value: "adapter", label: PG3.tabAdapters }]}
            />
          ) : <p className="models-note">{isImageRepo(repo) ? PG3_MISSING.imageHint : PG3_MISSING.saveOnly}</p>}
          {chatRepo ? <p className="models-note">{PG3_MISSING.modelsOnlyHint}</p> : null}
          {shownFiles ? <Table columns={fileColumns} rows={shownFiles} rowKey={(f) => f.name} caption={repo.repo} empty={chatRepo ? PG3_MISSING.noModelFile : PG3.emptySearch} /> : null}
        </section>
      ) : null}
    </>
  );
}
