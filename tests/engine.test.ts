import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildArgs, EngineManager, type EngineSpec } from "../server/engine";
import { EventBus } from "../server/events";
import { FAKE_LLAMA, tempDir, waitForEvent } from "./helpers";

const SPEC: EngineSpec = { presetId: "p1", modelPath: "/m.gguf", contextSize: 32768, adapterPaths: [] };

describe("buildArgs", () => {
  it("--parallel 1 で 127.0.0.1 だけに開く（D-60）", () => {
    const args = buildArgs(SPEC, "cuda", 1234, "key").join(" ");
    expect(args).toContain("--parallel 1");
    expect(args).toContain("--host 127.0.0.1 --port 1234 --api-key key");
    expect(args).toContain("-ngl auto");
    expect(args).toContain("--jinja");
    expect(args).toContain("--no-webui");
    expect(args).not.toContain("--lora");
  });

  it("CPU では GPU に載せない", () => {
    expect(buildArgs(SPEC, "cpu", 1, "k").join(" ")).toContain("-ngl 0");
  });

  it("LoRA はカンマ区切りで、倍率をかけずに読み込む", () => {
    const args = buildArgs({ ...SPEC, adapterPaths: ["/a.gguf", "/b.gguf"] }, "cuda", 1, "k");
    expect(args.join(" ")).toContain("--lora /a.gguf,/b.gguf --lora-init-without-apply");
  });
});

describe("EngineManager", () => {
  let temp: ReturnType<typeof tempDir>;
  let bus: EventBus;
  let engine: EngineManager;

  const create = (bin: string | null = FAKE_LLAMA) => {
    engine = new EngineManager({ bin, backend: "cpu", dataDir: temp.dir, bus, loadTimeoutMs: 1500, stopGraceMs: 300 });
    return engine;
  };

  beforeEach(() => {
    temp = tempDir();
    bus = new EventBus();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await engine.stop();
    temp.remove();
  });

  it("起動して ready になり、停止で pid を消す", async () => {
    await create().load(SPEC);
    expect(engine.state).toBe("ready");
    expect(existsSync(path.join(temp.dir, "runtime", "engine.pid"))).toBe(true);
    await engine.stop();
    expect(engine.state).toBe("stopped");
    expect(existsSync(path.join(temp.dir, "runtime", "engine.pid"))).toBe(false);
  });

  it("同じモデルなら読み込み直さない。倍率と生成設定の違いでは止めない（BR-01）", async () => {
    await create().load(SPEC);
    const url = engine.baseUrl;
    await engine.load({ ...SPEC, presetId: "p2" });
    expect(engine.baseUrl).toBe(url);
    expect(engine.presetId).toBe("p2");
  });

  it("文脈長が違えば読み込み直す", async () => {
    await create().load(SPEC);
    const url = engine.baseUrl;
    await engine.load({ ...SPEC, contextSize: 4096 });
    expect(engine.baseUrl).not.toBe(url);
    expect(engine.state).toBe("ready");
  });

  it("起動直後に落ちたら failed で、標準エラーの末尾を見せる", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "fail");
    await expect(create().load(SPEC)).rejects.toThrow(/not enough VRAM/);
    expect(engine.state).toBe("failed");
  });

  it("期限までに ready にならなければ止めて failed", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "hang");
    await expect(create().load(SPEC)).rejects.toThrow(/読み込めませんでした/);
    expect(engine.state).toBe("failed");
    expect(existsSync(path.join(temp.dir, "runtime", "engine.pid"))).toBe(false);
  });

  it("存在しないバイナリは failed", async () => {
    await expect(create("/no/such/llama-server").load(SPEC)).rejects.toThrow(/起動できません/);
    expect(engine.state).toBe("failed");
  });

  it("バイナリの指定がなければ failed", async () => {
    await expect(create(null).load(SPEC)).rejects.toThrow(/LLM_PARTY_LLAMA_BIN/);
  });

  it("動作中に落ちたら failed の engine イベントを出す", async () => {
    await create().load(SPEC);
    const pid = Number((await import("node:fs")).readFileSync(path.join(temp.dir, "runtime", "engine.pid"), "utf8"));
    process.kill(pid, "SIGKILL");
    const event = await waitForEvent(bus, (e) => e.event === "engine" && (e.data as { state: string }).state === "failed");
    expect((event.data as { error: string }).error).toBe("推論エンジンが停止しました");
  });

  it("標準出力と標準エラーをログに書く", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "fail");
    await create().load(SPEC).catch(() => undefined);
    expect(readdirSync(path.join(temp.dir, "logs"))[0]).toMatch(/^llama-server-\d{8}\.log$/);
  });

  it("関係ないプロセスの pid が残っていても止めない", () => {
    mkdirSync(path.join(temp.dir, "runtime"), { recursive: true });
    const pidFile = path.join(temp.dir, "runtime", "engine.pid");
    writeFileSync(pidFile, String(process.pid));
    create();
    expect(existsSync(pidFile)).toBe(false); // ここまで来た＝自分は生きている
  });
});
