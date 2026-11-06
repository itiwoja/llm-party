import { getConnection } from "./platform";

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function api<T>(pathname: string, body?: unknown): Promise<T> {
  const { baseUrl, token } = getConnection();
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(res.status, data?.error?.code ?? "INTERNAL", data?.error?.message ?? res.statusText);
  return data as T;
}

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
