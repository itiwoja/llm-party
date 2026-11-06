import { describe, expect, it } from "vitest";
import { GENERATION_SLOTS, GenerationSlot } from "../server/generation-slot";

describe("生成の枠", () => {
  it("枠は2本（--parallel と揃える）", () => {
    expect(GENERATION_SLOTS).toBe(2);
  });

  it("同じ読み込みなら2本まで一緒に持ち、3本目は来た順に待つ。二重の release は無視する", async () => {
    const slot = new GenerationSlot();
    const order: number[] = [];
    const first = await slot.acquire(new AbortController().signal, "a");
    const second = slot.acquire(new AbortController().signal, "a").then((release) => { order.push(2); return release; });
    const third = slot.acquire(new AbortController().signal, "a").then((release) => { order.push(3); return release; });
    order.push(1);
    const releaseSecond = await second;
    expect(order).toEqual([1, 2]);
    first();
    first();
    (await third)();
    releaseSecond();
    expect(order).toEqual([1, 2, 3]);
  });

  it("読み込みが違うと、持っている枠がすべて空くまで待つ（読み直しで動いている生成を止めない）", async () => {
    const slot = new GenerationSlot();
    const order: string[] = [];
    const first = await slot.acquire(new AbortController().signal, "a");
    const other = slot.acquire(new AbortController().signal, "b").then((release) => { order.push("b"); return release; });
    const same = slot.acquire(new AbortController().signal, "a").then((release) => { order.push("a2"); return release; });
    // 先頭が「b」なので、後ろの同じ「a」も待つ（来た順を守る）
    first();
    (await other)();
    (await same)();
    expect(order).toEqual(["b", "a2"]);
  });

  it("待っている間に止めたら列から外れ、次へ進む", async () => {
    const slot = new GenerationSlot();
    const first = await slot.acquire(new AbortController().signal, "a");
    const second = await slot.acquire(new AbortController().signal, "a");
    const abort = new AbortController();
    const stopped = slot.acquire(abort.signal, "a");
    const next = slot.acquire(new AbortController().signal, "a");
    abort.abort();
    await expect(stopped).rejects.toBeDefined();
    first();
    (await next)();
    second();
  });
});
