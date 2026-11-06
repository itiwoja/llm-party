import type { RequestHandler } from "express";

const BUFFER_SIZE = 1000;
const HEARTBEAT_MS = 15_000;

export interface BusEvent {
  id: number;
  event: string;
  data: unknown;
}

/** 画面への通知はすべてここを通る（07）。切断後の再送のため直近のイベントをメモリに持つ */
export class EventBus {
  private seq = 0;
  private buffer: BusEvent[] = [];
  private listeners = new Set<(event: BusEvent) => void>();

  publish(event: string, data: unknown): void {
    const item = { id: ++this.seq, event, data };
    this.buffer.push(item);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
    for (const listener of this.listeners) listener(item);
  }

  /** afterId より新しいイベントを返す。id が今の番号より大きいのは worker が起動し直した後なので、何も返さない */
  since(afterId: number): BusEvent[] {
    if (afterId > this.seq) return [];
    return this.buffer.filter((item) => item.id > afterId);
  }

  subscribe(listener: (event: BusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function format({ id, event, data }: BusEvent): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** API-099 */
export function eventsHandler(bus: EventBus): RequestHandler {
  return (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();

    const lastId = Number(req.headers["last-event-id"]);
    if (Number.isInteger(lastId) && lastId >= 0) {
      for (const item of bus.since(lastId)) res.write(format(item));
    }
    const unsubscribe = bus.subscribe((item) => res.write(format(item)));
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  };
}
