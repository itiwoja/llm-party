import { describe, expect, it } from "vitest";
import { GenerationSlot } from "../server/generation-slot";

describe("生成の順番待ち", () => {
  it("来た順に1つずつ渡す。二重の release は無視する", async () => {
    const slot = new GenerationSlot();
    const order: number[] = [];
    const first = await slot.acquire(new AbortController().signal);
    const second = slot.acquire(new AbortController().signal).then((release) => { order.push(2); return release; });
    const third = slot.acquire(new AbortController().signal).then((release) => { order.push(3); return release; });
    order.push(1);
    first();
    first();
    (await second)();
    (await third)();
    expect(order).toEqual([1, 2, 3]);
  });

  it("待っている間に止めたら列から外れ、次へ進む", async () => {
    const slot = new GenerationSlot();
    const first = await slot.acquire(new AbortController().signal);
    const abort = new AbortController();
    const stopped = slot.acquire(abort.signal);
    const next = slot.acquire(new AbortController().signal);
    abort.abort();
    await expect(stopped).rejects.toBeDefined();
    first();
    (await next)();
  });
});
