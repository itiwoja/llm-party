import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildArgs, EngineManager, type EngineSpec } from "../server/engine";
import { EventBus } from "../server/events";
import { installDirFor } from "../server/runtime/resolver";
import { FAKE_LLAMA, tempDir, waitForEvent } from "./helpers";

const SPEC: EngineSpec = { presetId: "p1", modelPath: "/m.gguf", contextSize: 32768, adapterPaths: [] };

describe("buildArgs", () => {
  it("--parallel は枠の数で 127.0.0.1 だけに開く（D-60 改訂）", () => {
    const args = buildArgs(SPEC, "cuda", 1234, "key").join(" ");
    expect(args).toContain("--parallel 2");
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

  it("存在しないパスの指定は警告して無視し、取得してから ready になる（ADR-012）", async () => {
    const events: { state: string; warning?: string }[] = [];
    bus.subscribe((event) => { if (event.event === "engine") events.push(event.data as never); });
    engine = new EngineManager({
      bin: "/no/such/llama-server", backend: "cpu", dataDir: temp.dir, bus, loadTimeoutMs: 1500, stopGraceMs: 300,
      installer: async () => FAKE_LLAMA,
    });
    expect(engine.warning).toContain("/no/such/llama-server");
    await engine.load(SPEC);
    expect(engine.state).toBe("ready");
    expect(engine.warning).toContain("/no/such/llama-server");
    expect(events.some((e) => e.state === "ready" && e.warning?.includes("/no/such/llama-server"))).toBe(true);
  });

  it("存在しないパスの指定でも、取得済みならそれを使う（取得しない）", async () => {
    // GPU の有無は実機で変わるので、どちらの種類にも置く
    for (const flavor of ["cpu", "cuda"] as const) {
      const dir = installDirFor(temp.dir, flavor);
      mkdirSync(dir, { recursive: true });
      copyFileSync(FAKE_LLAMA, path.join(dir, "llama-server"));
      chmodSync(path.join(dir, "llama-server"), 0o755);
    }
    const installer = vi.fn(async () => FAKE_LLAMA);
    engine = new EngineManager({
      bin: "/no/such/llama-server", backend: "cpu", dataDir: temp.dir, bus, loadTimeoutMs: 1500, stopGraceMs: 300, installer,
    });
    await engine.load(SPEC);
    expect(engine.state).toBe("ready");
    expect(installer).not.toHaveBeenCalled();
    expect(engine.warning).toContain("/no/such/llama-server");
  });

  it("名前だけの指定で起動できなければ failed（警告は出さない）", async () => {
    await expect(create("no-such-llama-server-name").load(SPEC)).rejects.toThrow(/起動できません/);
    expect(engine.state).toBe("failed");
    expect(engine.warning).toBeNull();
  });

  it("指定がなく取得もまだなら、取得してから読み込む（installing → ready・進捗つき）", async () => {
    const events: { state: string; installPercent?: number }[] = [];
    bus.subscribe((event) => { if (event.event === "engine") events.push(event.data as never); });
    engine = new EngineManager({
      bin: null, backend: "cpu", dataDir: temp.dir, bus, loadTimeoutMs: 1500, stopGraceMs: 300,
      installer: async ({ onProgress }) => {
        onProgress(50);
        return FAKE_LLAMA;
      },
    });
    await engine.load(SPEC);
    expect(engine.state).toBe("ready");
    expect(events.some((e) => e.state === "installing" && e.installPercent === 50)).toBe(true);
    expect(events.findIndex((e) => e.state === "installing")).toBeLessThan(events.findIndex((e) => e.state === "ready"));
  });

  it("取得に失敗したら failed で、理由を画面に出す", async () => {
    engine = new EngineManager({
      bin: null, backend: "cpu", dataDir: temp.dir, bus, loadTimeoutMs: 1500, stopGraceMs: 300,
      installer: async () => { throw new Error("取得に失敗しました（3 回試しました）"); },
    });
    await expect(engine.load(SPEC)).rejects.toThrow(/取得に失敗しました/);
    expect(engine.state).toBe("failed");
    expect(engine.error).toContain("3 回試しました");
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
