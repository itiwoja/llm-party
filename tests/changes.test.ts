import { existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_LLAMA, SAMPLING, startWorker, tempDir, type TestWorker, waitForEvent, writeGguf } from "./helpers";

describe("変更記録・差分・取り消し（FR-011）", () => {
  let worker: TestWorker;
  let scratch: ReturnType<typeof tempDir>;
  let ws: string;
  beforeEach(async () => {
    worker = await startWorker(FAKE_LLAMA);
    scratch = tempDir();
    ws = realpathSync(scratch.dir);
  });
  afterEach(async () => {
    await worker.close();
    scratch.remove();
    vi.unstubAllEnvs();
  });

  const write = (id: string, file: string, content: string) => ({ id, name: "write_file", arguments: { path: file, content } });
  const edit = (id: string, file: string, oldText: string, newText: string) => ({ id, name: "edit_file", arguments: { path: file, oldText, newText } });

  /** 自動承認のスレッドで、台本どおりに1ターン動かす */
  async function run(steps: unknown[]) {
    const file = path.join(worker.dir, "script.json");
    writeFileSync(file, JSON.stringify(steps));
    vi.stubEnv("FAKE_LLAMA_SCRIPT", file);
    const model = path.join(worker.dir, "model.gguf");
    writeGguf(model);
    const registered = await worker.api("/models", { body: { path: model, mode: "reference" } });
    const preset = await worker.api("/presets", { body: { name: "対話", modelId: registered.body.id, sampling: SAMPLING, thinking: false, contextSize: 8192, systemPrompt: "" } });
    const workspace = await worker.api("/workspaces", { body: { path: ws } });
    const thread = await worker.api("/threads", { body: { presetId: preset.body.id, workspaceId: workspace.body.id } });
    await worker.api(`/threads/${thread.body.id}`, { method: "PATCH", body: { autoApprove: true } });
    const sent = await worker.api(`/threads/${thread.body.id}/turns`, { body: { presetId: preset.body.id, content: "やって" } });
    const done = await waitForEvent(worker.context.bus, (e) => e.event === "turn.finished" && (e.data as any).turnId === sent.body.turnId);
    expect(done.data).toMatchObject({ status: "completed" });
    return thread.body.id as string;
  }
  const changes = async (threadId: string) => (await worker.api(`/threads/${threadId}/changes`)).body;
  const revert = (id: string, force?: boolean) => worker.api(`/file-changes/${id}/revert`, { body: force === undefined ? {} : { force } });
  const read = (file: string) => readFileSync(path.join(ws, file), "utf8");

  it("write_file / edit_file の前後が記録され、新規の取り消しはファイルを消す", async () => {
    const threadId = await run([{ toolCalls: [write("c1", "new.txt", "hello\n")] }, { content: "ok" }]);
    const { items, files } = await changes(threadId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: "new.txt", before: null, after: "hello\n", revertedAt: null });
    expect(items[0].afterSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(items[0].diff).toContain("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello");
    expect(files).toEqual([{ path: "new.txt", changeIds: [items[0].id], diff: items[0].diff }]);

    const res = await revert(items[0].id);
    expect(res.status).toBe(200);
    expect(res.body.revertedAt).toBeTruthy();
    expect(existsSync(path.join(ws, "new.txt"))).toBe(false);
    expect((await changes(threadId)).items[0].revertedAt).toBe(res.body.revertedAt);
    // 2回目は取り消し済み
    expect((await revert(items[0].id)).status).toBe(409);
  });

  it("そのまま戻す。既存ファイルは実行前の中身に戻る", async () => {
    writeFileSync(path.join(ws, "a.txt"), "orig\nline2\n");
    const threadId = await run([{ toolCalls: [edit("c1", "a.txt", "orig", "changed")] }, { content: "ok" }]);
    expect(read("a.txt")).toBe("changed\nline2\n");
    const { items } = await changes(threadId);
    expect(items[0].diff).toContain("-orig\n+changed");
    expect((await revert(items[0].id)).status).toBe(200);
    expect(read("a.txt")).toBe("orig\nline2\n");
  });

  it("変更後に編集されていたら 409。force で戻せる", async () => {
    writeFileSync(path.join(ws, "a.txt"), "orig\n");
    const threadId = await run([{ toolCalls: [write("c1", "a.txt", "ai\n")] }, { content: "ok" }]);
    writeFileSync(path.join(ws, "a.txt"), "人が編集\n");
    const { items } = await changes(threadId);
    const refused = await revert(items[0].id);
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "CONFLICT" } } });
    expect(read("a.txt")).toBe("人が編集\n");
    expect((await changes(threadId)).items[0].revertedAt).toBeNull();
    expect((await revert(items[0].id, false)).status).toBe(409);
    expect((await revert(items[0].id, true)).status).toBe(200);
    expect(read("a.txt")).toBe("orig\n");
  });

  it("同じファイルの複数回の変更：まとめた差分と1回ずつ。途中の変更は後の変更と矛盾するので 409", async () => {
    const threadId = await run([
      { toolCalls: [write("c1", "f.txt", "v1\n"), edit("c2", "f.txt", "v1", "v2")] },
      { content: "ok" },
    ]);
    const { items, files } = await changes(threadId);
    expect(items.map((i: any) => [i.before, i.after])).toEqual([[null, "v1\n"], ["v1\n", "v2\n"]]);
    expect(files).toHaveLength(1);
    expect(files[0].changeIds).toEqual(items.map((i: any) => i.id));
    expect(files[0].diff).toContain("--- /dev/null");
    expect(files[0].diff).toContain("+v2");
    expect(files[0].diff).not.toContain("+v1");
    expect(items[1].diff).toContain("-v1\n+v2");

    // 先の変更は、後の変更が残っているのでハッシュが合わず戻せない
    expect((await revert(items[0].id)).status).toBe(409);
    expect(read("f.txt")).toBe("v2\n");
    // 後の変更から順に戻せる
    expect((await revert(items[1].id)).status).toBe(200);
    expect(read("f.txt")).toBe("v1\n");
    expect((await changes(threadId)).files[0].diff).toBe(items[0].diff); // 取り消し済みはまとめた差分に入らない
    expect((await revert(items[0].id)).status).toBe(200);
    expect(existsSync(path.join(ws, "f.txt"))).toBe(false);
  });

  it("途中の変更を force で戻すと、後の変更はもう戻せない", async () => {
    const threadId = await run([{ toolCalls: [write("c1", "f.txt", "v1\n"), edit("c2", "f.txt", "v1", "v2")] }, { content: "ok" }]);
    const { items } = await changes(threadId);
    expect((await revert(items[0].id, true)).status).toBe(200);
    expect(existsSync(path.join(ws, "f.txt"))).toBe(false);
    expect((await revert(items[1].id)).status).toBe(409);
  });

  it("パスは今のワークスペースで検査し直す：外を指すようになった記録は拒否", async () => {
    const threadId = await run([{ toolCalls: [write("c1", "f.txt", "v1\n")] }, { content: "ok" }]);
    const { items } = await changes(threadId);
    const outside = tempDir();
    symlinkSync(realpathSync(outside.dir), path.join(ws, "link"));
    worker.context.db.prepare("UPDATE file_changes SET path = ? WHERE id = ?").run("link/f.txt", items[0].id);
    writeFileSync(path.join(outside.dir, "f.txt"), "v1\n");
    const res = await revert(items[0].id, true);
    expect(res).toMatchObject({ status: 400, body: { error: { code: "PATH_NOT_ALLOWED" } } });
    expect(read("f.txt")).toBe("v1\n");
    expect(readFileSync(path.join(outside.dir, "f.txt"), "utf8")).toBe("v1\n");
    worker.context.db.prepare("UPDATE file_changes SET path = ? WHERE id = ?").run("../x.txt", items[0].id);
    expect((await revert(items[0].id, true)).status).toBe(400);
    outside.remove();
  });

  it("存在しない記録・スレッドは 404", async () => {
    expect((await revert("nothing")).status).toBe(404);
    expect((await worker.api("/threads/nothing/changes")).status).toBe(404);
  });

  it("新しいスレッドの自動承認は設定 defaultAutoApprove から読む（API-031）", async () => {
    const model = path.join(worker.dir, "m.gguf");
    writeGguf(model);
    const registered = await worker.api("/models", { body: { path: model, mode: "reference" } });
    const preset = await worker.api("/presets", { body: { name: "対話", modelId: registered.body.id, sampling: SAMPLING, thinking: false, contextSize: 8192, systemPrompt: "" } });
    expect((await worker.api("/threads", { body: { presetId: preset.body.id } })).body.autoApprove).toBe(false);
    worker.context.db.prepare("INSERT INTO settings (key, value) VALUES ('defaultAutoApprove', 'true')").run();
    expect((await worker.api("/threads", { body: { presetId: preset.body.id } })).body.autoApprove).toBe(true);
    worker.context.db.prepare("UPDATE settings SET value = 'broken' WHERE key = 'defaultAutoApprove'").run();
    expect((await worker.api("/threads", { body: { presetId: preset.body.id } })).body.autoApprove).toBe(false);
  });
});
