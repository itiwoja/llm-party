import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unifiedDiff } from "../server/agent/diff";
import { checkWorkspace, isSystemPath, PathDeniedError, resolveInWorkspace } from "../server/agent/paths";
import { shellInvocation } from "../server/agent/shell";
import { ToolCallAssembler } from "../server/agent/stream";
import { planToolCall, toolDefinitions, type FileChange, type ToolContext } from "../server/agent/tools";
import { truncateOutput } from "../server/agent/truncate";
import { tempDir } from "./helpers";

describe("データフォルダを読み取りツールから隠す", () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => { tmp = tempDir(); });
  afterEach(() => tmp.remove());

  it("search と list_dir はワークスペース内の deny の中へ入らない", async () => {
    const ws = realpathSync(tmp.dir);
    mkdirSync(path.join(ws, "data"));
    writeFileSync(path.join(ws, "data", "local-token"), "secret-value");
    writeFileSync(path.join(ws, "a.txt"), "secret-value");
    const context: ToolContext = { workspace: ws, deny: [path.join(ws, "data")], signal: new AbortController().signal, commandTimeoutMs: 5000 };
    const run = async (name: string, args: unknown) => {
      const plan = planToolCall(name, JSON.stringify(args), context);
      if (!plan.ok) throw new Error(plan.message);
      return (await plan.run()).output;
    };
    expect(await run("search", { pattern: "secret" })).toBe("a.txt:1: secret-value");
    expect(await run("list_dir", { path: ".", depth: 3 })).not.toContain("local-token");
  });
});

describe("ワークスペースに選べる場所（FR-007）", () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => { tmp = tempDir(); });
  afterEach(() => tmp.remove());

  it("ふつうのフォルダは実体のパスで通る。リンク経由でも実体になる", () => {
    const real = path.join(tmp.dir, "project");
    mkdirSync(real);
    symlinkSync(real, path.join(tmp.dir, "link"));
    const opts = { dataDir: path.join(tmp.dir, "data"), home: "/home/nobody" };
    expect(checkWorkspace(real, opts)).toBe(realpathSync(real));
    expect(checkWorkspace(path.join(tmp.dir, "link"), opts)).toBe(realpathSync(real));
  });

  it("ないフォルダ・ファイルは選べない", () => {
    writeFileSync(path.join(tmp.dir, "f"), "");
    expect(checkWorkspace(path.join(tmp.dir, "none"), { dataDir: "/x" })).toBeNull();
    expect(checkWorkspace(path.join(tmp.dir, "f"), { dataDir: "/x" })).toBeNull();
  });

  it("/・ホーム直下・システムのフォルダ・データフォルダは選べない。ホームの下は選べる", () => {
    const home = path.join(tmp.dir, "home");
    mkdirSync(path.join(home, "dev"), { recursive: true });
    const data = path.join(tmp.dir, "data");
    mkdirSync(path.join(data, "db"), { recursive: true });
    const opts = { dataDir: data, home };

    expect(checkWorkspace("/", opts)).toBeNull();
    expect(checkWorkspace(home, opts)).toBeNull();
    expect(checkWorkspace(path.join(home, "dev"), opts)).not.toBeNull();
    for (const dir of ["/etc", "/usr", "/usr/lib", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev", "/var"]) {
      expect(checkWorkspace(dir, opts), dir).toBeNull();
    }
    expect(checkWorkspace(data, opts)).toBeNull();
    expect(checkWorkspace(path.join(data, "db"), opts)).toBeNull();
    // 実在する環境のときだけ確かめる
    for (const dir of ["/mnt/c"]) {
      if (realpathSafe(dir)) expect(checkWorkspace(dir, opts), dir).toBeNull();
    }
  });

  it("os.homedir() 直下も選べない", () => {
    expect(checkWorkspace(os.homedir(), { dataDir: "/x" })).toBeNull();
  });
});

function realpathSafe(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

describe("パスの解決（FR-010）", () => {
  let tmp: ReturnType<typeof tempDir>;
  let ws: string;
  let outside: string;
  beforeEach(() => {
    tmp = tempDir();
    ws = realpathSync(tmp.dir) + "/ws";
    outside = realpathSync(tmp.dir) + "/outside";
    mkdirSync(ws);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "秘密");
    mkdirSync(path.join(ws, "sub"));
    writeFileSync(path.join(ws, "a.txt"), "a");
  });
  afterEach(() => tmp.remove());

  it("中のパスは実体で返す。まだない新規ファイルは親を解決する", () => {
    expect(resolveInWorkspace(ws, "a.txt")).toBe(`${ws}/a.txt`);
    expect(resolveInWorkspace(ws, "sub/new/deep.txt")).toBe(`${ws}/sub/new/deep.txt`);
    expect(resolveInWorkspace(ws, ".")).toBe(ws);
    expect(resolveInWorkspace(ws, `${ws}/a.txt`)).toBe(`${ws}/a.txt`);
  });

  it(".. と絶対パスで外に出るのを拒否する", () => {
    expect(() => resolveInWorkspace(ws, "../outside/secret.txt")).toThrow(PathDeniedError);
    expect(() => resolveInWorkspace(ws, "sub/../../outside")).toThrow(PathDeniedError);
    expect(() => resolveInWorkspace(ws, `${outside}/secret.txt`)).toThrow(PathDeniedError);
    expect(() => resolveInWorkspace(ws, "/etc/passwd")).toThrow(PathDeniedError);
    // 名前が前方一致するだけの隣のフォルダ
    mkdirSync(`${ws}-evil`);
    expect(() => resolveInWorkspace(ws, "../ws-evil/x")).toThrow(PathDeniedError);
  });

  it("シンボリックリンクでの脱出を拒否する（ファイル・フォルダ・新規ファイルの親・壊れたリンク）", () => {
    symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "file-link"));
    symlinkSync(outside, path.join(ws, "dir-link"));
    symlinkSync(path.join(outside, "missing"), path.join(ws, "dangling"));
    expect(() => resolveInWorkspace(ws, "file-link")).toThrow(PathDeniedError);
    expect(() => resolveInWorkspace(ws, "dir-link")).toThrow(PathDeniedError);
    expect(() => resolveInWorkspace(ws, "dir-link/secret.txt")).toThrow(PathDeniedError);
    expect(() => resolveInWorkspace(ws, "dir-link/new.txt")).toThrow(PathDeniedError);
    expect(() => resolveInWorkspace(ws, "dangling")).toThrow(PathDeniedError);
    // リンクの手前で .. を使っても、辿った先で判定する
    expect(() => resolveInWorkspace(ws, "dir-link/../ws/a.txt")).not.toThrow();
  });

  it("中を指すリンクは通る。ワークスペース自体がリンクでも実体で判定する", () => {
    symlinkSync(path.join(ws, "sub"), path.join(ws, "inner"));
    expect(resolveInWorkspace(ws, "inner")).toBe(`${ws}/sub`);
    symlinkSync(ws, path.join(tmp.dir, "ws-link"));
    expect(resolveInWorkspace(path.join(tmp.dir, "ws-link"), "a.txt")).toBe(`${ws}/a.txt`);
  });

  it("deny に入れた場所（データフォルダ）はワークスペースの中でも拒否する", () => {
    mkdirSync(path.join(ws, "data"));
    expect(() => resolveInWorkspace(ws, "data/local-token", { deny: [path.join(ws, "data")] })).toThrow(PathDeniedError);
    expect(resolveInWorkspace(ws, "a.txt", { deny: [path.join(ws, "data")] })).toBe(`${ws}/a.txt`);
  });
});

describe("ツール", () => {
  let tmp: ReturnType<typeof tempDir>;
  let ws: string;
  let changes: FileChange[];
  let context: ToolContext;
  beforeEach(() => {
    tmp = tempDir();
    ws = realpathSync(tmp.dir);
    changes = [];
    context = { workspace: ws, deny: [], signal: new AbortController().signal, commandTimeoutMs: 5000, onFileChange: (c) => changes.push(c) };
  });
  afterEach(() => tmp.remove());

  const run = async (name: string, args: unknown) => {
    const plan = planToolCall(name, JSON.stringify(args), context);
    if (!plan.ok) return plan;
    return { plan, result: await plan.run() };
  };

  it("6 つのツールを定義する", () => {
    expect(toolDefinitions().map((tool) => tool.function.name)).toEqual(["list_dir", "read_file", "search", "write_file", "edit_file", "run_command"]);
    expect(toolDefinitions()[1].function.parameters).toMatchObject({ type: "object", required: ["path"] });
  });

  it("edit_file：0 か所は失敗、複数は失敗、1 か所は置換、replaceAll は全部", async () => {
    writeFileSync(path.join(ws, "a.txt"), "foo bar\nfoo baz\nqux\n");
    const none = planToolCall("edit_file", JSON.stringify({ path: "a.txt", oldText: "nothing", newText: "x" }), context);
    expect(none).toMatchObject({ ok: false, status: "failed" });
    expect((none as { message: string }).message).toContain("見つかりません");

    const many = planToolCall("edit_file", JSON.stringify({ path: "a.txt", oldText: "foo", newText: "x" }), context);
    expect(many).toMatchObject({ ok: false, status: "failed" });
    expect((many as { message: string }).message).toContain("2 か所");
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("foo bar\nfoo baz\nqux\n");

    const one = await run("edit_file", { path: "a.txt", oldText: "qux", newText: "QUX" });
    expect(one).toMatchObject({ result: { status: "succeeded" } });
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("foo bar\nfoo baz\nQUX\n");

    const all = await run("edit_file", { path: "a.txt", oldText: "foo", newText: "x", replaceAll: true });
    expect(all).toMatchObject({ result: { status: "succeeded" } });
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("x bar\nx baz\nQUX\n");
    // FR-011 の差し込み口には前後の中身が渡る
    expect(changes.map((c) => [c.path, c.before, c.after])).toEqual([
      ["a.txt", "foo bar\nfoo baz\nqux\n", "foo bar\nfoo baz\nQUX\n"],
      ["a.txt", "foo bar\nfoo baz\nQUX\n", "x bar\nx baz\nQUX\n"],
    ]);
  });

  it("edit_file はないファイルを失敗にする", async () => {
    expect(await run("edit_file", { path: "none.txt", oldText: "a", newText: "b" })).toMatchObject({ ok: false, status: "failed" });
  });

  it("write_file：新規作成（フォルダも作る）と上書き。プレビューに差分が付く", async () => {
    const created = await run("write_file", { path: "d/e/new.txt", content: "一行目\n二行目\n" });
    expect(created).toMatchObject({ plan: { kind: "write" }, result: { status: "succeeded" } });
    expect((created as { plan: { preview: string } }).plan.preview).toContain("--- /dev/null\n+++ b/d/e/new.txt");
    expect(readFileSync(path.join(ws, "d/e/new.txt"), "utf8")).toBe("一行目\n二行目\n");
    expect(changes[0]).toEqual({ path: "d/e/new.txt", before: null, after: "一行目\n二行目\n" });

    const over = planToolCall("write_file", JSON.stringify({ path: "d/e/new.txt", content: "一行目\n変更\n" }), context);
    expect(over).toMatchObject({ ok: true });
    expect((over as { preview: string }).preview).toContain("-二行目\n+変更");
  });

  it("書き込みと読み取りはワークスペース外で denied", async () => {
    symlinkSync("/etc", path.join(ws, "etc-link"));
    expect(planToolCall("read_file", JSON.stringify({ path: "../x" }), context)).toMatchObject({ ok: false, status: "denied" });
    expect(planToolCall("write_file", JSON.stringify({ path: "etc-link/passwd", content: "x" }), context)).toMatchObject({ ok: false, status: "denied" });
    expect(planToolCall("run_command", JSON.stringify({ command: "ls", cwd: "etc-link" }), context)).toMatchObject({ ok: false, status: "denied" });
  });

  it("不明なツール・壊れた JSON・足りない引数は失敗として返す", () => {
    expect(planToolCall("rm_rf", "{}", context)).toMatchObject({ ok: false, status: "failed" });
    expect(planToolCall("read_file", "{\"path\": \"a", context)).toMatchObject({ ok: false, status: "failed" });
    expect(planToolCall("read_file", "{}", context)).toMatchObject({ ok: false, status: "failed" });
  });

  it("read_file：行番号つき・範囲・バイナリと 2MB 超は読まない", async () => {
    writeFileSync(path.join(ws, "r.txt"), "a\nb\nc\n");
    expect(await run("read_file", { path: "r.txt" })).toMatchObject({ result: { output: "1\ta\n2\tb\n3\tc" } });
    expect(await run("read_file", { path: "r.txt", startLine: 2, endLine: 2 })).toMatchObject({ result: { output: "2\tb" } });
    expect(await run("read_file", { path: "r.txt", startLine: 9 })).toMatchObject({ result: { status: "failed" } });
    writeFileSync(path.join(ws, "bin"), Buffer.from([1, 0, 2]));
    expect(await run("read_file", { path: "bin" })).toMatchObject({ result: { status: "failed", output: "バイナリファイルは読めません" } });
    writeFileSync(path.join(ws, "big"), "x".repeat(2 * 1024 * 1024 + 1));
    expect(await run("read_file", { path: "big" })).toMatchObject({ result: { status: "failed" } });
  });

  it("list_dir：深さと .git・node_modules の中は見せない", async () => {
    mkdirSync(path.join(ws, "src/deep"), { recursive: true });
    mkdirSync(path.join(ws, "node_modules/pkg"), { recursive: true });
    mkdirSync(path.join(ws, ".git"));
    writeFileSync(path.join(ws, "src/x.ts"), "");
    writeFileSync(path.join(ws, "src/deep/y.ts"), "");
    writeFileSync(path.join(ws, "README.md"), "");
    expect(await run("list_dir", { path: "." })).toMatchObject({ result: { output: ".git/\nnode_modules/\nREADME.md\nsrc/" } });
    const deep = await run("list_dir", { path: ".", depth: 3 });
    expect((deep as { result: { output: string } }).result.output).toBe(".git/\nnode_modules/\nREADME.md\nsrc/\n  deep/\n    y.ts\n  x.ts");
  });

  it("search：正規表現・glob・バイナリ除外・パス:行番号: 内容", async () => {
    mkdirSync(path.join(ws, "src"));
    writeFileSync(path.join(ws, "src/a.ts"), "const foo = 1;\nconst bar = 2;\n");
    writeFileSync(path.join(ws, "src/b.md"), "foo in docs\n");
    writeFileSync(path.join(ws, "bin"), Buffer.from("foo\0"));
    mkdirSync(path.join(ws, "node_modules"));
    writeFileSync(path.join(ws, "node_modules/c.ts"), "foo\n");
    expect(await run("search", { pattern: "fo+" })).toMatchObject({ result: { output: "src/a.ts:1: const foo = 1;\nsrc/b.md:1: foo in docs" } });
    expect(await run("search", { pattern: "foo", glob: "*.ts" })).toMatchObject({ result: { output: "src/a.ts:1: const foo = 1;" } });
    expect(await run("search", { pattern: "zzz" })).toMatchObject({ result: { output: "一致なし" } });
    expect(await run("search", { pattern: "(" })).toMatchObject({ result: { status: "failed" } });
  });

  it("run_command：終了コードと出力。cwd を使う", async () => {
    mkdirSync(path.join(ws, "sub"));
    const ok = await run("run_command", { command: "pwd; echo err >&2", cwd: "sub" });
    expect(ok).toMatchObject({ plan: { kind: "command" }, result: { status: "succeeded", exitCode: 0 } });
    expect((ok as { result: { output: string } }).result.output).toBe(`終了コード: 0\n${ws}/sub\nerr\n`);
    expect(await run("run_command", { command: "exit 3" })).toMatchObject({ result: { status: "failed", exitCode: 3 } });
  });
});

describe("出力の切り詰め（D-26）", () => {
  const count = async (text: string) => text.length;

  it("上限以内はそのまま", async () => {
    expect(await truncateOutput("a\nb\n", count, 100)).toBe("a\nb\n");
  });

  it("超えたら先頭と末尾を残して間を FR-009 の文言で省く", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `行${i}`).join("\n");
    const out = await truncateOutput(lines, count, 400);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.startsWith("行0\n行1\n")).toBe(true);
    expect(out.endsWith("行998\n行999")).toBe(true);
    const omitted = Number(/…(\d+) 行省略。startLine \/ endLine を指定して読めます…/.exec(out)?.[1]);
    expect(omitted).toBeGreaterThan(0);
    const kept = out.split("\n").filter((line) => line.startsWith("行")).length;
    expect(kept + omitted).toBe(1000);
  });

  it("改行のない巨大な 1 行でも収める", async () => {
    const out = await truncateOutput("x".repeat(5000), count, 400);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain("行省略");
  });

  it("バイト数が上限以下なら数えない", async () => {
    let calls = 0;
    await truncateOutput("あ".repeat(10), async () => { calls += 1; return 0; }, 100);
    expect(calls).toBe(0);
  });
});

describe("unified diff", () => {
  it("変更行とハンクの位置を出す", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const after = before.replace("l3\n", "L3\n").replace("l18\n", "L18\n");
    expect(unifiedDiff("f.txt", before, after)).toBe(
      ["--- a/f.txt", "+++ b/f.txt", "@@ -1,6 +1,6 @@", " l1", " l2", "-l3", "+L3", " l4", " l5", " l6",
        "@@ -15,6 +15,6 @@", " l15", " l16", " l17", "-l18", "+L18", " l19", " l20"].join("\n"),
    );
  });

  it("新規は /dev/null から。差がなければ空", () => {
    expect(unifiedDiff("n.txt", null, "a\nb\n")).toBe("--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b");
    expect(unifiedDiff("n.txt", "a\n", "a\n")).toBe("");
  });
});

describe("ストリームの tool_calls の組み立て", () => {
  it("index ごとの断片をつなげ、並んだ順に返す。id がなければ作る", () => {
    const assembler = new ToolCallAssembler();
    assembler.add([{ index: 0, id: "c0", function: { name: "read_file", arguments: "" } }]);
    assembler.add([{ index: 1, function: { name: "list_dir", arguments: "{\"pa" } }]);
    assembler.add([{ index: 0, function: { arguments: "{\"path\":" } }, { index: 1, function: { arguments: "th\":\".\"}" } }]);
    assembler.add([{ index: 0, function: { arguments: "\"a.txt\"}" } }]);
    expect(assembler.result(() => "made")).toEqual([
      { id: "c0", name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
      { id: "made", name: "list_dir", arguments: "{\"path\":\".\"}" },
    ]);
  });
});

describe("Windows の実行環境（D-86）", () => {
  it("FR-007 の場所を Windows のパスで見分ける", () => {
    for (const blocked of ["C:\\", "d:", "C:\\Windows", "c:\\windows\\system32", "C:\\Program Files", "C:\\Program Files (x86)\\app"]) {
      expect(isSystemPath(blocked, "win32")).toBe(true);
    }
    for (const allowed of ["C:\\Users\\me\\work", "D:\\repos\\app", "C:\\WindowsApps"]) {
      expect(isSystemPath(allowed, "win32")).toBe(false);
    }
  });

  it("PowerShell へは日本語や引用符が崩れない形で渡す", () => {
    const { file, args } = shellInvocation(`echo "日本語"`, "win32");
    expect(file).toBe("powershell.exe");
    const script = args.at(-1)!;
    const body = /FromBase64String\('([^']+)'\)/.exec(script)![1];
    const decoded = Buffer.from(body, "base64").toString("utf8");
    expect(decoded.startsWith(`echo "日本語"\n`)).toBe(true);
    expect(decoded).toMatch(/exit \$LASTEXITCODE/);
    expect(script.indexOf("UTF8Encoding")).toBeLessThan(script.indexOf("Invoke-Expression"));
  });

  it("Linux では bash のまま", () => {
    expect(shellInvocation("ls", "linux")).toEqual({ file: "/bin/bash", args: ["-c", "ls"] });
  });
});
