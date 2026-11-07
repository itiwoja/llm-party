import { ApiError } from "../http-error";
import { GENRES, GGUF_ONLY_GENRES, type Genre } from "./genres";
import { assertRepo, encodePath, type TreeFile } from "./names";
import { DEFAULT_GPU_RATIO, fits, memoryNeed, q4Bytes, type MemoryLimit } from "./memory";
import { readHfToken } from "./token";

/** 切れた・混んでいるなど、待てば直るかもしれない失敗 */
export class RetryableError extends Error {}

const MAX_REDIRECTS = 5;
/** tree の続きを辿る回数の上限（暴走防止） */
const MAX_TREE_PAGES = 100;
const SEARCH_LIMIT = 50;
/** VRAM・RAM で絞るときは、絞った後も結果が残るよう多めに取る（HF はサイズで絞れない） */
const FILTER_FETCH_LIMIT = 100;
/** 検索で使う項目。指定しないと lastModified と gated が返らない。指定すると既定の項目も消えるので全部書く */
const SEARCH_FIELDS = ["downloads", "lastModified", "createdAt", "gated", "pipeline_tag", "tags", "gguf", "safetensors"];

/** GGUF か safetensors のパラメータ数を取る */
function sizeOf(item: { gguf?: { total?: unknown }; safetensors?: { total?: unknown } }): Pick<HfRepo, "params"> {
  const total = item.gguf?.total ?? item.safetensors?.total;
  return { params: typeof total === "number" && total > 0 ? total : null };
}

export const GATED_MESSAGE = "ゲート付きリポジトリ。設定で HF トークンが必要";
const CONNECT_MESSAGE = "Hugging Face に接続不可。「あとで」で先へ";

export interface HfRepo {
  repo: string;
  downloads: number;
  updatedAt: string | null;
  createdAt: string | null;
  gated: boolean;
  pipelineTag: string | null;
  /** `license:` タグの値。HF に無ければ null */
  license: string | null;
  /** パラメータ数（GGUF か safetensors の値）。分からなければ null */
  params: number | null;
}

export interface HfSearch extends Partial<MemoryLimit> {
  query: string;
  genre: Genre;
  uncensored: boolean;
  /** 絞り込みで使う、GPU に載せる割合（0〜100）。VRAM・RAM の目安はこれで変わる */
  gpuRatio?: number;
}

/** HF との通信。トークンは HF 自身のオリジンにだけ付け、リダイレクト先（CDN）には送らない */
export class HfClient {
  constructor(private baseUrl: string, private dataDir: string) {}

  private get origin(): string {
    return new URL(this.baseUrl).origin;
  }

  /** リダイレクトを自分で辿り、ホップごとにトークンを付けるか決める */
  async fetch(url: URL, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    const token = readHfToken(this.dataDir);
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const headers: Record<string, string> = { ...init.headers };
      if (token && current.origin === this.origin) headers.Authorization = `Bearer ${token}`;
      let res: Response;
      try {
        res = await fetch(current, { headers, signal: init.signal, redirect: "manual" });
      } catch (error) {
        if (init.signal?.aborted) throw error;
        throw new RetryableError(CONNECT_MESSAGE);
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        current = new URL(location, current);
        continue;
      }
      return res;
    }
    throw new ApiError("UPSTREAM_ERROR", CONNECT_MESSAGE);
  }

  /** 失敗の応答を API のエラーにする。5xx・429 は再試行できるものとして区別する */
  async check(res: Response): Promise<Response> {
    if (res.ok) return res;
    await res.body?.cancel();
    if (res.status === 401 || res.status === 403) throw new ApiError("AUTH_REQUIRED_UPSTREAM", GATED_MESSAGE);
    if (res.status === 404) throw new ApiError("NOT_FOUND", "対象がありません");
    if (res.status >= 500 || res.status === 429) throw new RetryableError(CONNECT_MESSAGE);
    throw new ApiError("UPSTREAM_ERROR", CONNECT_MESSAGE);
  }

  private async json(url: URL): Promise<{ body: unknown; link: string | null }> {
    try {
      const res = await this.check(await this.fetch(url, { headers: { Accept: "application/json" } }));
      return { body: await res.json(), link: res.headers.get("link") };
    } catch (error) {
      // 一覧の取得は再試行せず、画面にそのまま失敗を返す
      if (error instanceof RetryableError || error instanceof SyntaxError) throw new ApiError("UPSTREAM_ERROR", CONNECT_MESSAGE);
      throw error;
    }
  }

  /** ジャンルと語で探す。pipeline_tag が複数のジャンルは検索ごとの結果を DL 数の順に混ぜる */
  async search({ query, genre, uncensored, vram = null, ram = null, gpuRatio = DEFAULT_GPU_RATIO }: HfSearch): Promise<HfRepo[]> {
    const tags: readonly (string | null)[] = GENRES[genre].length > 0 ? GENRES[genre] : [null];
    const filters = [...(GGUF_ONLY_GENRES.includes(genre) ? ["gguf"] : []), ...(uncensored ? ["uncensored"] : [])];
    const limit = vram === null && ram === null ? SEARCH_LIMIT : FILTER_FETCH_LIMIT;
    const results = await Promise.all(tags.map((tag) => this.searchOne(query, tag, filters, limit)));
    const merged = new Map(results.flat().map((repo) => [repo.repo, repo]));
    return [...merged.values()]
      .filter((repo) => fits(repo.params === null ? null : memoryNeed(q4Bytes(repo.params), gpuRatio), { vram, ram }))
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, SEARCH_LIMIT);
  }

  private async searchOne(query: string, pipelineTag: string | null, filters: string[], limit: number): Promise<HfRepo[]> {
    const url = new URL("/api/models", this.baseUrl);
    const params = new URLSearchParams({ sort: "downloads", limit: String(limit) });
    if (query) params.set("search", query);
    if (pipelineTag) params.set("pipeline_tag", pipelineTag);
    for (const filter of filters) params.append("filter", filter); // filter を重ねると AND になる
    for (const field of SEARCH_FIELDS) params.append("expand[]", field);
    url.search = params.toString();
    const { body } = await this.json(url);
    if (!Array.isArray(body)) throw new ApiError("UPSTREAM_ERROR", CONNECT_MESSAGE);
    return body.map((item) => ({
      repo: String(item.id ?? item.modelId),
      downloads: Number(item.downloads ?? 0),
      updatedAt: item.lastModified ?? null,
      createdAt: item.createdAt ?? null,
      gated: Boolean(item.gated),
      pipelineTag: item.pipeline_tag ?? null,
      license: (item.tags as string[] | undefined)?.find((tag) => tag.startsWith("license:"))?.slice("license:".length) ?? null,
      ...sizeOf(item),
    }));
  }

  /** リポジトリの全ファイル。tree は続きがあるので Link ヘッダーの next を最後まで辿る */
  async listFiles(repo: string): Promise<TreeFile[]> {
    assertRepo(repo);
    const files: TreeFile[] = [];
    let url: URL | null = new URL(`/api/models/${encodePath(repo)}/tree/main?recursive=true`, this.baseUrl);
    for (let page = 0; url && page < MAX_TREE_PAGES; page += 1) {
      const { body, link } = await this.json(url);
      if (!Array.isArray(body)) throw new ApiError("UPSTREAM_ERROR", CONNECT_MESSAGE);
      for (const entry of body) {
        if (entry.type !== "file") continue;
        files.push({ path: entry.path, size: Number(entry.lfs?.size ?? entry.size), sha256: entry.lfs?.oid ?? null });
      }
      const next: string | undefined = link?.split(",").map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1]).find(Boolean);
      // 続きの URL でも接続先は設定のものを使う（Link のホストを信用しない）
      url = next ? new URL(new URL(next, this.baseUrl).pathname + new URL(next, this.baseUrl).search, this.baseUrl) : null;
    }
    return files;
  }

  resolveUrl(repo: string, file: string): URL {
    return new URL(`/${encodePath(repo)}/resolve/main/${encodePath(file)}`, this.baseUrl);
  }
}
