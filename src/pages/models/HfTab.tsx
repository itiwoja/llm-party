import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiRequestError } from "../../api";
import { Button } from "../../components/Button";
import { SelectField, SwitchField } from "../../components/Controls";
import { GpuRatioField } from "../../components/GpuRatioField";
import { SearchField } from "../../components/SearchField";
import { Table, type Column } from "../../components/Table";
import { MISSING_COPY } from "../../copy";
import { hrefOf } from "../../router";
import { DEFAULT_GPU_RATIO, memoryNeed, q4Bytes } from "../../../server/hf/memory";
import { PG3, PG3_MISSING } from "./copy";
import { ErrorLine } from "./ErrorLine";
import { distinctLabels } from "./fileLabel";
import { BYTES_PER_GB, errorMessage, formatBytes, formatDate } from "./format";
import type { HfFile, HfRepo } from "./types";


type Genre = keyof typeof PG3_MISSING.genres;
type Purpose = keyof typeof PG3_MISSING.purposes;
/** VRAM・RAM は GB の上限。null は指定なし */
interface Filters { query: string; genre: Genre; uncensored: boolean; effort: boolean; thinking: boolean; purpose: Purpose; vram: number | null; ram: number | null; gpuRatio: number }

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
const PURPOSE_OPTIONS = (Object.keys(PG3_MISSING.purposes) as Purpose[]).map((value) => ({ value, label: PG3_MISSING.purposes[value] }));

/** 思考・用途の絞り込みが入っているか。入っていれば結果はチャットのモデルだけ（D-90） */
const narrowsChat = ({ effort, thinking, purpose }: Filters) => effort || thinking || purpose !== "all";

/** mmproj（画像の入力部）・imatrix（量子化の計算用）・mtp（先読みの補助部分）は、どのリポジトリでもモデル本体ではないので出さない */
const isAuxFile = (name: string) => /^(mmproj|imatrix|mtp)[-_.]/i.test(name.split("/").pop() ?? name);
/** チャット用に出すのはモデル本体の GGUF だけ */
const isModelFile = (name: string) => name.toLowerCase().endsWith(".gguf") && !isAuxFile(name);

/** 401 は設定の HF トークンへ案内する（CP-096） */
export function hfFailure(err: unknown): ReactNode {
  if (err instanceof ApiRequestError && err.code === "AUTH_REQUIRED_UPSTREAM") {
    return <ErrorLine message={PG3.gated}> <a href={hrefOf("/settings")}>{PG3_MISSING.linkToSettings}</a></ErrorLine>;
  }
  return <ErrorLine message={errorMessage(err)} />;
}

/** API-098・107 の一覧の1件 */
interface Recipe { id: string; name: string; sizeBytes: number; installed: boolean }

/** 部品を一括で取るモデルの行（画像 API-097・098、音楽 API-106・107）。画面は切り替えない（進みは DL の画面で見る） */
function RecipeRow({ url, id, note }: { url: string; id: string; note: string }) {
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [queued, setQueued] = useState(false);

  useEffect(() => {
    api.get<{ items: Recipe[] }>(url).then(({ items }) => setRecipe(items.find((r) => r.id === id) ?? null)).catch(setFailure);
  }, [url, id]);

  async function start() {
    setFailure(null);
    setQueued(false);
    setStarting(true);
    try {
      await api(url, { recipe: id });
      setQueued(true);
    } catch (err) {
      setFailure(err);
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      {recipe ? (
        <section className="models-recipe" aria-label={recipe.name}>
          <div>
            <strong>{recipe.name}</strong>
            <p className="models-note">{note}</p>
            <p className="models-note numeric">{PG3_MISSING.recipeTotal(gbText(recipe.sizeBytes / BYTES_PER_GB))}</p>
          </div>
          {recipe.installed ? (
            <span className="models-note">{PG3_MISSING.recipeInstalled}</span>
          ) : (
            <Button size="sm" loading={starting} disabled={starting || queued} onClick={() => void start()}>
              {PG3_MISSING.recipeStart}
            </Button>
          )}
        </section>
      ) : null}
      {failure ? hfFailure(failure) : null}
      {queued ? <p className="models-note" role="status">{PG3_MISSING.recipeQueued}</p> : null}
    </>
  );
}

/** Hugging Face を探す（API-053〜055）。語は Enter で送り、ジャンル・無検閲・思考・用途は変えた時点で探し直す */
export function HfTab({ onStarted }: { onStarted(): void }) {
  const [filters, setFilters] = useState<Filters>({ query: "", genre: "all", uncensored: false, effort: false, thinking: false, purpose: "all", vram: null, ram: null, gpuRatio: DEFAULT_GPU_RATIO })
  // バーを動かしている間の値。表はこの値ですぐ変え、絞り込みは離したときに探し直す
  const [gpuRatio, setGpuRatio] = useState(DEFAULT_GPU_RATIO);
  // 数字の入力中は文字のまま持ち、欄を離れたか Enter で絞り込む
  const [memoryDraft, setMemoryDraft] = useState({ vram: "", ram: "" });
  const [repos, setRepos] = useState<HfRepo[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [repo, setRepo] = useState<HfRepo | null>(null);
  const [files, setFiles] = useState<HfFile[] | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  // ジャンルを続けて変えたとき、古い検索の結果で上書きしない
  const latestSearch = useRef(0);
  const filesRef = useRef<HTMLElement>(null);

  // ファイル一覧は長い表の下に開くので、開いたら見える所まで動かす。読み込み後は下に余白ができるのでもう一度動かす
  useEffect(() => {
    if (repo) filesRef.current?.scrollIntoView({ block: "start" });
  }, [repo, files]);

  /** keepOpen はバーからの探し直し。開いているファイル一覧を閉じない */
  async function search(current: Filters, keepOpen = false) {
    const { query, genre, uncensored, effort, thinking, purpose, vram, ram, gpuRatio: gpu } = current;
    const q = query.trim();
    const id = (latestSearch.current += 1);
    setFailure(null);
    if (!keepOpen) {
      setRepo(null);
      setFiles(null);
    }
    if (!q && genre === "all" && !uncensored && !narrowsChat(current) && vram === null && ram === null) {
      setRepos(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ q, genre, uncensored: String(uncensored), effort: String(effort), thinking: String(thinking), purpose });
      if (vram !== null) params.set("vram", String(vram));
      if (ram !== null) params.set("ram", String(ram));
      if (vram !== null || ram !== null) params.set("gpu", String(gpu));
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

  /** バーを離したとき。上限が入っているときだけ結果が変わるので探し直す */
  function commitRatio() {
    if (gpuRatio === filters.gpuRatio) return;
    const next = { ...filters, gpuRatio };
    setFilters(next);
    if (next.vram !== null || next.ram !== null) void search(next, true);
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
      setFiles((await api.get<{ items: HfFile[] }>(`/hf/files?repo=${encodeURIComponent(row.repo)}&use=${row.use}`)).items);
    } catch (err) {
      setFailure(err);
    }
  }

  async function start(file: HfFile) {
    if (!repo) return;
    setFailure(null);
    setStarting(file.name);
    try {
      await api("/downloads", { repo: repo.repo, files: [file.name], kind: chatRepo ? "model" : "image" });
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
  // チャットは GGUF のモデルだけを出す。画像は API が一体型と確かめたファイルだけ返す（D-89）
  const chatRepo = repo?.use === "chat";
  // 強さ順（容量が大きいほど強い）に並べる。同じ容量は名前順
  const shownFiles = files
    ?.filter((f) => !chatRepo || isModelFile(f.name))
    .sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));

  const repoNeed = (r: HfRepo) => (r.params === null ? null : memoryNeed(q4Bytes(r.params), gpuRatio));
  const ratioField = <GpuRatioField value={gpuRatio} onChange={setGpuRatio} onCommit={commitRatio} />;

  const repoColumns: Column<HfRepo>[] = [
    { key: "repo", header: PG3_MISSING.colRepo, render: (r) => <button type="button" className="link-btn numeric">{r.repo}</button> },
    { key: "strength", header: PG3_MISSING.colStrength, render: (r) => <StrengthBar params={r.params} max={maxParams} /> },
    { key: "genre", header: PG3_MISSING.genre, render: (r) => <span className="models-nowrap">{PG3_MISSING.genres[r.use]}</span> },
    { key: "thinking", header: PG3_MISSING.colThinking, render: (r) => <span className="models-nowrap">{r.supportsEffort ? PG3_MISSING.thinkingEffort : r.supportsThinking ? PG3_MISSING.thinkingSwitch : ""}</span> },
    { key: "license", header: PG3_MISSING.colLicense, render: (r) => <span className="numeric models-nowrap">{r.license ?? ""}</span> },
    { key: "vram", header: PG3_MISSING.colVram, numeric: true, render: (r) => { const need = repoNeed(r); return need ? gbText(need.vramGb) : ""; } },
    { key: "ram", header: PG3_MISSING.colRam, numeric: true, render: (r) => { const need = repoNeed(r); return need ? gbText(need.ramGb) : ""; } },
    { key: "downloads", header: PG3_MISSING.colDownloads, numeric: true, render: (r) => r.downloads.toLocaleString("en-US") },
    // updatedAt が null（HF が lastModified を返さない）ときは空にする。createdAt は出さない
    { key: "updated", header: PG3_MISSING.colUpdated, numeric: true, render: (r) => <span className="models-nowrap">{formatDate(r.updatedAt)}</span> },
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
    { key: "size", header: PG3_MISSING.colFileSize, numeric: true, render: (f) => formatBytes(f.sizeBytes) },
    { key: "vram", header: PG3_MISSING.colVram, numeric: true, render: (f) => gbText(memoryNeed(f.sizeBytes, gpuRatio).vramGb) },
    { key: "ram", header: PG3_MISSING.colRam, numeric: true, render: (f) => gbText(memoryNeed(f.sizeBytes, gpuRatio).ramGb) },
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
      <RecipeRow url="/image-recipes" id="moss-image" note={PG3_MISSING.recipeNote} />
      <RecipeRow url="/music-recipes" id="ace-step" note={PG3_MISSING.musicRecipeNote} />
      <div className="models-filters">
        <SelectField label={PG3_MISSING.genre} hideLabel value={filters.genre} options={GENRE_OPTIONS} onValueChange={(v) => refine({ genre: v as Genre, ...(v === "image" ? { effort: false, thinking: false, purpose: "all" as const } : {}) })} />
        {filters.genre === "image" ? null : (
          <>
            <SelectField label={PG3_MISSING.purpose} hideLabel value={filters.purpose} options={PURPOSE_OPTIONS} onValueChange={(v) => refine({ purpose: v as Purpose })} />
            <SwitchField label={PG3_MISSING.effortOnly} checked={filters.effort} onCheckedChange={(effort) => refine({ effort })} />
            <SwitchField label={PG3_MISSING.thinkingOnly} checked={filters.thinking} onCheckedChange={(thinking) => refine({ thinking })} />
          </>
        )}
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
      {narrowsChat(filters) ? <p className="models-note">{PG3_MISSING.chatOnlyHint}</p> : null}
      {ratioField}
      <p className="models-note">{PG3_MISSING.splitHint}</p>
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
          <p className="models-note">{chatRepo ? PG3_MISSING.modelsOnlyHint : PG3_MISSING.imageHint}</p>
          {shownFiles ? ratioField : null}
          {shownFiles ? <Table columns={fileColumns} rows={shownFiles} rowKey={(f) => f.name} caption={repo.repo} empty={chatRepo ? PG3_MISSING.noModelFile : PG3_MISSING.noImageFile} /> : null}
        </section>
      ) : null}
    </>
  );
}
