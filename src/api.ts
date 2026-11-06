import { getConnection } from "./platform";

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: { field?: string; message?: string; name?: string }[] = []) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

async function request<T>(method: Method, pathname: string, body?: unknown): Promise<T> {
  const { baseUrl, token } = getConnection();
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(res.status, data?.error?.code ?? "INTERNAL", data?.error?.message ?? res.statusText, data?.error?.details);
  return data as T;
}

/** `api(path)` は GET、`api(path, body)` は POST。ほかの動詞は `api.patch` などを使う */
export const api = Object.assign(
  <T>(pathname: string, body?: unknown) => request<T>(body === undefined ? "GET" : "POST", pathname, body),
  {
    get: <T>(pathname: string) => request<T>("GET", pathname),
    post: <T>(pathname: string, body?: unknown) => request<T>("POST", pathname, body ?? {}),
    patch: <T>(pathname: string, body: unknown) => request<T>("PATCH", pathname, body),
    put: <T>(pathname: string, body: unknown) => request<T>("PUT", pathname, body),
    delete: <T = null>(pathname: string) => request<T>("DELETE", pathname),
  },
);

export interface ServerEvent {
  event: string;
  data: any;
}

/** API-099。EventSource はヘッダーを付けられないので fetch で読み、切れたらつなぎ直す */
export function subscribeEvents(onEvent: (event: ServerEvent) => void): () => void {
  const abort = new AbortController();
  let lastId: string | null = null;

  async function connect(): Promise<void> {
    const { baseUrl, token } = getConnection();
    const res = await fetch(`${baseUrl}/events`, {
      signal: abort.signal,
      headers: { Authorization: `Bearer ${token ?? ""}`, ...(lastId ? { "Last-Event-ID": lastId } : {}) },
    });
    if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
        const event = field("event");
        const data = field("data");
        lastId = field("id") ?? lastId;
        if (event && data) onEvent({ event, data: JSON.parse(data) });
      }
    }
  }

  void (async () => {
    while (!abort.signal.aborted) {
      await connect().catch(() => undefined);
      if (!abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();
  return () => abort.abort();
}
