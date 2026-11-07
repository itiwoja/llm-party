import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostModelCache } from "../server/host-model-cache";
import { tempDir } from "./helpers";

describe("Windows のディスクの写し（D-85）", () => {
  let temp: ReturnType<typeof tempDir>;
  let cache: HostModelCache;
  let source: string;
  const dir = () => path.join(temp.dir, "copies");

  beforeEach(() => {
    temp = tempDir();
    source = path.join(temp.dir, "a", "model.gguf");
    mkdirSync(path.dirname(source));
    writeFileSync(source, "abc");
    cache = new HostModelCache(dir());
  });
  afterEach(() => temp.remove());

  it("初回は写し、2 回目は写し直さない", async () => {
    const copy = await cache.localize(source);
    expect(copy).not.toBe(source);
    expect(readFileSync(copy, "utf8")).toBe("abc");

    writeFileSync(copy, "xyz");
    expect(await cache.localize(source)).toBe(copy);
    expect(readFileSync(copy, "utf8")).toBe("xyz");
  });

  it("大きさが違えば写し直し、書きかけは残さない", async () => {
    const copy = await cache.localize(source);
    writeFileSync(source, "abcdef");
    await cache.localize(source);
    expect(readFileSync(copy, "utf8")).toBe("abcdef");
    expect(readdirSync(dir()).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });

  it("別のフォルダの同名ファイルと混ざらない", async () => {
    const other = path.join(temp.dir, "b", "model.gguf");
    mkdirSync(path.dirname(other));
    writeFileSync(other, "other");
    expect(await cache.localize(other)).not.toBe(await cache.localize(source));
  });

  it("写せなければ元のパスを返す", async () => {
    const missing = path.join(temp.dir, "none.gguf");
    expect(await cache.localize(missing)).toBe(missing);
  });

  it("drop で写しだけ消え、元は残る", async () => {
    const copy = await cache.localize(source);
    await cache.drop(source);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(source)).toBe(true);
  });
});
