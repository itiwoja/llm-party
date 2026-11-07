import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createApp, type AppOptions } from "../server/app";
import { type Context, createContext } from "../server/context";
import { EventBus, type BusEvent } from "../server/events";

export const TOKEN = "secret";
export const FAKE_LLAMA = path.resolve("tests/fixtures/fake-llama.mjs");

export const SAMPLING = { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 };

export function tempDir(): { dir: string; remove(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "llm-party-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface TestWorker {
  port: number;
  dir: string;
  context: Context;
  api(pathname: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

export async function startWorker(
  bin: string | null = FAKE_LLAMA,
  options: { hfBaseUrl?: string; extraRoutes?: AppOptions["extraRoutes"]; commandTimeoutMs?: number; sdBin?: string | null; aceDir?: string | null } = {},
): Promise<TestWorker> {
  const { dir, remove } = tempDir();
  const context = createContext({ bin, backend: "cpu", dataDir: dir, loadTimeoutMs: 3000, stopGraceMs: 500, hfBaseUrl: options.hfBaseUrl, commandTimeoutMs: options.commandTimeoutMs, sdBin: options.sdBin ?? null, aceDir: options.aceDir ?? null });
  // Host の検査に実際のポートを使うので、先に空きポートを取ってから app を作る
  const probe = createApp({ port: 0, token: TOKEN, context }).listen(0, "127.0.0.1");
  await new Promise((resolve) => probe.once("listening", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const server: Server = createApp({ port, token: TOKEN, context, extraRoutes: options.extraRoutes }).listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  return {
    port, dir, context,
    async api(pathname, init = {}) {
      const res = await fetch(`http://127.0.0.1:${port}/api${pathname}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await context.close();
      remove();
    },
  };
}

/** 条件に合うイベントが来るまで待つ */
export function waitForEvent(bus: EventBus, match: (event: BusEvent) => boolean, timeoutMs = 5000): Promise<BusEvent> {
  const found = bus.since(0).find(match);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("イベントが来ません")), timeoutMs);
    const unsubscribe = bus.subscribe((event) => {
      if (!match(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

function kvString(key: string, value: string): Buffer[] {
  return [str(key), u32(8), str(value)];
}
function kvU32(key: string, value: number): Buffer[] {
  return [str(key), u32(4), u32(value)];
}
function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}
function u64(value: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}
function str(value: string): Buffer {
  const raw = Buffer.from(value);
  return Buffer.concat([u64(raw.length), raw]);
}

/** 語彙の配列を含む、最小の GGUF を書く */
export function writeGguf(file: string, options: { type?: string; contextLength?: number; chatTemplate?: string } = {}): void {
  const tokens = ["a", "b", "c"];
  const entries = [
    ...kvString("general.architecture", "testarch"),
    ...kvString("general.type", options.type ?? "model"),
    ...kvString("general.name", "Test Model"),
    ...kvU32("general.file_type", 15),
    str("tokenizer.ggml.tokens"), u32(9), u32(8), u64(tokens.length), ...tokens.map(str),
    ...kvU32("testarch.context_length", options.contextLength ?? 65536),
    ...kvU32("testarch.block_count", 32),
    ...(options.chatTemplate === undefined ? [] : kvString("tokenizer.chat_template", options.chatTemplate)),
  ];
  const count = options.chatTemplate === undefined ? 7 : 8;
  writeFileSync(file, Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(count), ...entries]));
}

/** sd-server の代役（画像生成のテスト用） */
export const FAKE_SD = path.resolve("tests/fixtures/fake-sd.mjs");
