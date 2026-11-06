import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../server/events";
import { startWorker, TOKEN, type TestWorker } from "./helpers";

describe("EventBus", () => {
  it("指定した番号より後だけ返す", () => {
    const bus = new EventBus();
    bus.publish("a", 1);
    bus.publish("b", 2);
    bus.publish("c", 3);
    expect(bus.since(1).map((event) => event.event)).toEqual(["b", "c"]);
  });

  it("worker の起動し直しで番号が飛んだら再送しない", () => {
    const bus = new EventBus();
    bus.publish("a", 1);
    expect(bus.since(500)).toEqual([]);
  });

  it("古いイベントは捨てる", () => {
    const bus = new EventBus();
    for (let i = 0; i < 1100; i += 1) bus.publish("x", i);
    expect(bus.since(0)).toHaveLength(1000);
  });
});

describe("API-099", () => {
  let worker: TestWorker;
  afterEach(() => worker.close());

  it("Last-Event-ID の続きから送り、その後のイベントも流す", async () => {
    worker = await startWorker(null);
    const { bus } = worker.context;
    bus.publish("first", { n: 1 });
    bus.publish("second", { n: 2 });

    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${worker.port}/api/events`, {
      headers: { Authorization: `Bearer ${TOKEN}`, "Last-Event-ID": "1" },
      signal: abort.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    const decoder = new TextDecoder();
    bus.publish("third", { n: 3 });
    while (!text.includes("third")) text += decoder.decode((await reader.read()).value);
    abort.abort();

    expect(text).not.toContain("event: first");
    expect(text).toContain("id: 2\nevent: second\ndata: {\"n\":2}");
    expect(text).toContain("event: third");
  });
});
