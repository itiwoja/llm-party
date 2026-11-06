import { ApiError } from "../http-error";
import { assertRepo, encodePath, type TreeFile } from "./names";
import { readHfToken } from "./token";

/** 切れた・混んでいるなど、待てば直るかもしれない失敗 */
export class RetryableError extends Error {}

const MAX_REDIRECTS = 5;
/** tree の続きを辿る回数の上限（暴走防止） */
const MAX_TREE_PAGES = 100;
const SEARCH_LIMIT = 20;

export const GATED_MESSAGE = "ゲート付きリポジトリ。設定で HF トークンが必要";
const CONNECT_MESSAGE = "Hugging Face に接続不可。「あとで」で先へ";

export interface HfRepo {
  repo: string;
  downloads: number;
  updatedAt: string | null;
  createdAt: string | null;
  gated: boolean;
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

  async search(query: string): Promise<HfRepo[]> {
    const url = new URL("/api/models", this.baseUrl);
    url.search = new URLSearchParams({ search: query, filter: "gguf", sort: "downloads", limit: String(SEARCH_LIMIT) }).toString();
    const { body } = await this.json(url);
    if (!Array.isArray(body)) throw new ApiError("UPSTREAM_ERROR", CONNECT_MESSAGE);
    return body.map((item) => ({
      repo: String(item.id ?? item.modelId),
      downloads: Number(item.downloads ?? 0),
      updatedAt: item.lastModified ?? null,
      createdAt: item.createdAt ?? null,
      gated: Boolean(item.gated),
    }));
  }

  /** .gguf だけを返す。tree は続きがあるので Link ヘッダーの next を最後まで辿る */
  async listGguf(repo: string): Promise<TreeFile[]> {
    assertRepo(repo);
    const files: TreeFile[] = [];
    let url: URL | null = new URL(`/api/models/${encodePath(repo)}/tree/main?recursive=true`, this.baseUrl);
    for (let page = 0; url && page < MAX_TREE_PAGES; page += 1) {
      const { body, link } = await this.json(url);
      if (!Array.isArray(body)) throw new ApiError("UPSTREAM_ERROR", CONNECT_MESSAGE);
      for (const entry of body) {
        if (entry.type !== "file" || !String(entry.path).toLowerCase().endsWith(".gguf")) continue;
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
