import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localRoutes } from "../server/routes/local";
import { checkpointBytes, ggufBytes, startFakeHf, type FakeHf } from "./fixtures/fake-hf";
import { FAKE_LLAMA, startWorker, type TestWorker } from "./helpers";

const data = ggufBytes({ padding: 100 });
let hf: FakeHf;
let worker: TestWorker;

beforeEach(async () => {
  hf = await startFakeHf({
    "acme/tiny-GGUF": {
      pipelineTag: "text-generation",
      params: 9e9,
      files: [
        { path: "tiny-Q4_K_M.gguf", data },
        { path: "tiny-Q8_0.gguf", data },
        { path: "tiny-BF16-00002-of-00002.gguf", data },
        { path: "tiny-BF16-00001-of-00002.gguf", data },
        { path: "sub/tiny-Q2_K.gguf", data },
      ],
    },
    "acme/lonely-GGUF": { files: [{ path: "lonely-Q4_K_M-00002-of-00003.gguf", data }, { path: "lonely-Q4_K_M-00003-of-00003.gguf", data }] },
    "acme/gated-GGUF": { pipelineTag: "text-generation", gatedToken: "hf_secret", files: [{ path: "g-Q4_K_M.gguf", data }] },
    "acme/chat-GGUF": { pipelineTag: "text-generation", params: 3e9, files: [{ path: "c-Q4_K_M.gguf", data }] },
    "acme/chat-raw": { pipelineTag: "text-generation", tags: [], files: [] },
    "acme/vision-GGUF": { pipelineTag: "image-text-to-text", params: 13e9, files: [{ path: "v-Q4_K_M.gguf", data }] },
    "acme/sdxl": {
      pipelineTag: "text-to-image", pipeline: "StableDiffusionXLPipeline", tags: ["diffusers:StableDiffusionXLPipeline"],
      files: [
        { path: "sdxl.safetensors", data: checkpointBytes() },
        { path: "offset-lora.safetensors", data: checkpointBytes(["lora_unet_a.lora_down.weight"]) },
        { path: "vae/diffusion_pytorch_model.safetensors", data: checkpointBytes(["first_stage_model.b"]) },
        { path: "broken.safetensors", data: Buffer.from("not safetensors") },
        { path: "model-00001-of-00002.safetensors", data }, { path: "model-00002-of-00002.safetensors", data },
      ],
    },
    "acme/sdxl-uncensored": { pipelineTag: "text-to-image", pipeline: "StableDiffusionPipeline", tags: ["diffusers:StableDiffusionPipeline", "uncensored"], files: [{ path: "sd.safetensors", data: checkpointBytes() }] },
    "acme/split-only": { pipelineTag: "text-to-image", tags: [], files: [{ path: "model-00001-of-00002.safetensors", data }, { path: "model-00002-of-00002.safetensors", data }, { path: "vae/config.json", data: Buffer.from("{}") }] },
    "acme/flux": { pipelineTag: "text-to-image", pipeline: "FluxPipeline", tags: ["diffusers:StableDiffusionPipeline"], files: [{ path: "flux.safetensors", data: checkpointBytes() }] },
    "acme/no-tag-GGUF": { files: [{ path: "x.gguf", data }] },
    "acme/Text-Encoder-GGUF": { pipelineTag: "image-text-to-text", files: [{ path: "x.gguf", data }] },
    "acme/rewriter-GGUF": { pipelineTag: "text-generation", tags: ["gguf", "prompt-rewriting"], files: [{ path: "x.gguf", data }] },
    "acme/lora-GGUF": { pipelineTag: "text-generation", chatTemplate: false, files: [{ path: "lora.gguf", data }] },
    "acme/unknown-arch-GGUF": { pipelineTag: "text-generation", architecture: "brand-new", files: [{ path: "x.gguf", data }] },
    "acme/no-meta-GGUF": { pipelineTag: "text-generation", architecture: null, files: [{ path: "x.gguf", data }] },
    "acme/encoder-GGUF": { pipelineTag: "text-to-image", files: [{ path: "te.gguf", data }] },
    "acme/embed-a": { pipelineTag: "feature-extraction", tags: [], files: [] },
    "acme/embed-b": { pipelineTag: "sentence-similarity", tags: [], files: [] },
  });
  worker = await startWorker(FAKE_LLAMA, { hfBaseUrl: hf.baseUrl, extraRoutes: localRoutes });
});

afterEach(async () => {
  await worker.close();
  await hf.close();
});

describe("API-053 検索", () => {
  it("名前・DL 数・更新日を返す", async () => {
    const res = await worker.api("/hf/search?q=tiny");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { repo: "acme/tiny-GGUF", downloads: 1000, updatedAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", gated: false, pipelineTag: "text-generation", license: "mit", params: 9e9, use: "chat" },
    ]);
    const search = new URL(`http://x${hf.hfRequests.at(-1)!.url}`).searchParams;
    expect(search.get("search")).toBe("tiny");
    expect(search.get("limit")).toBe("100");
  });

  it("語もジャンルもなければ 400", async () => {
    expect((await worker.api("/hf/search?q=")).status).toBe(400);
  });

  it("ゲート付きかどうかが分かる", async () => {
    const res = await worker.api("/hf/search?q=gated");
    expect(res.body.items[0].gated).toBe(true);
  });

  it("知らないジャンルは 400", async () => {
    expect((await worker.api("/hf/search?genre=nope")).status).toBe(400);
  });

  const repos = (res: { body: any }) => res.body.items.map((item: any) => item.repo);

  it("ジャンルだけで一覧できる（語は送らない）", async () => {
    expect(repos(await worker.api("/hf/search?genre=image"))).toEqual(["acme/sdxl", "acme/sdxl-uncensored"]);
    const search = new URL(`http://x${hf.hfRequests.at(-1)!.url}`).searchParams;
    expect(search.get("pipeline_tag")).toBe("text-to-image");
    expect(search.has("search")).toBe(false);
  });

  it("ジャンルと語は両方効く", async () => {
    expect(repos(await worker.api("/hf/search?q=uncensored&genre=image"))).toEqual(["acme/sdxl-uncensored"]);
  });

  it("無検閲はタグの絞り込みで、ジャンルと組み合わせられる", async () => {
    expect(repos(await worker.api("/hf/search?genre=image&uncensored=true"))).toEqual(["acme/sdxl-uncensored"]);
    expect(repos(await worker.api("/hf/search?uncensored=true"))).toEqual(["acme/sdxl-uncensored"]);
  });

  it("使えると確定しないリポジトリは検索に出さない（D-89）", async () => {
    expect(repos(await worker.api("/hf/search?q=embed"))).toEqual([]);
    for (const name of ["flux", "lora-GGUF", "unknown-arch-GGUF", "no-meta-GGUF", "encoder-GGUF", "no-tag-GGUF", "Text-Encoder-GGUF", "rewriter-GGUF"]) {
      expect(repos(await worker.api(`/hf/search?q=${name}`))).toEqual([]);
    }
    expect((await worker.api("/hf/search?genre=embedding")).status).toBe(400);
  });

  it("画像のファイルは、一体型と確かめられた直下の .safetensors だけ返す（D-89）", async () => {
    const res = await worker.api("/hf/files?repo=acme/sdxl&use=image");
    expect(res.body.items.map((item: any) => item.name)).toEqual(["sdxl.safetensors"]);
  });

  it("チャットのジャンルは動かせる GGUF だけ", async () => {
    expect(repos(await worker.api("/hf/search?genre=chat"))).toEqual(["acme/tiny-GGUF", "acme/gated-GGUF", "acme/chat-GGUF", "acme/vision-GGUF"]);
  });

  describe("VRAM・RAM で絞る（目安は Q4_K_M で計算）", () => {
    // 語を「acme/」にすると全部の候補が対象になる（パラメータ数がないものは絞ると外れる）
    it("VRAM の上限を超えるものは外す。パラメータ数が分からないものも外す", async () => {
      expect(repos(await worker.api("/hf/search?q=acme/&vram=8"))).toEqual(["acme/tiny-GGUF", "acme/chat-GGUF"]);
    });

    it("RAM も同じく効く。両方あれば両方を満たすものだけ", async () => {
      expect(repos(await worker.api("/hf/search?q=acme/&vram=8&ram=4"))).toEqual(["acme/tiny-GGUF", "acme/chat-GGUF"]);
      expect(repos(await worker.api("/hf/search?q=acme/&vram=8&ram=3"))).toEqual([]);
    });

    it("GPU の割合で VRAM と RAM の目安が変わる", async () => {
      expect(repos(await worker.api("/hf/search?q=acme/&ram=8&gpu=0"))).toEqual(["acme/chat-GGUF"]);
      expect(repos(await worker.api("/hf/search?q=acme/&ram=8&gpu=100"))).toEqual(["acme/tiny-GGUF", "acme/chat-GGUF", "acme/vision-GGUF"]);
      expect((await worker.api("/hf/search?q=acme/&gpu=101")).status).toBe(400);
    });

    it("語もジャンルもなくても、VRAM か RAM だけで一覧できる", async () => {
      expect((await worker.api("/hf/search?vram=8")).status).toBe(200);
      expect(repos(await worker.api("/hf/search?vram=6"))).toEqual(["acme/chat-GGUF"]);
    });

    it("ジャンルと組み合わせられる", async () => {
      expect(repos(await worker.api("/hf/search?genre=chat&vram=8"))).toEqual(["acme/tiny-GGUF", "acme/chat-GGUF"]);
      expect(repos(await worker.api("/hf/search?genre=chat&vram=2"))).toEqual([]);
    });

    it("絞るときは多めに取ってから絞る（HF の件数上限 100）", async () => {
      await worker.api("/hf/search?q=acme/&vram=8");
      expect(new URL(`http://x${hf.hfRequests.at(-1)!.url}`).searchParams.get("limit")).toBe("100");
    });

    it("上限は正の数だけ。0・負・数字でない値は 400", async () => {
      expect((await worker.api("/hf/search?vram=0")).status).toBe(400);
      expect((await worker.api("/hf/search?ram=-1")).status).toBe(400);
      expect((await worker.api("/hf/search?vram=abc")).status).toBe(400);
    });

    it("空欄は指定なし。空欄だけなら語もジャンルもないので 400", async () => {
      expect((await worker.api("/hf/search?vram=")).status).toBe(400);
      expect((await worker.api("/hf/search?q=tiny&vram=")).status).toBe(200);
    });
  });

  it("HF が落ちていれば 502", async () => {
    await hf.close();
    const res = await worker.api("/hf/search?q=tiny");
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("UPSTREAM_ERROR");
    hf = await startFakeHf();
  });
});

describe("API-054 ファイル一覧", () => {
  it("分割をまとめ、量子化とサイズを出す", async () => {
    const res = await worker.api("/hf/files?repo=acme/tiny-GGUF");
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.items.map((item: any) => [item.name, item]));
    expect(Object.keys(byName).sort()).toEqual(["README.md", "sub/tiny-Q2_K.gguf", "tiny-BF16-00001-of-00002.gguf", "tiny-Q4_K_M.gguf", "tiny-Q8_0.gguf"]);
    expect(byName["tiny-BF16-00001-of-00002.gguf"]).toMatchObject({ split: true, complete: true, quantization: "BF16", sizeBytes: data.length * 2 });
    expect(byName["tiny-BF16-00001-of-00002.gguf"].parts.map((part: any) => part.name)).toEqual([
      "tiny-BF16-00001-of-00002.gguf", "tiny-BF16-00002-of-00002.gguf",
    ]);
    expect(byName["tiny-Q4_K_M.gguf"]).toMatchObject({ split: false, quantization: "Q4_K_M", sizeBytes: data.length });
    expect(byName["sub/tiny-Q2_K.gguf"].quantization).toBe("Q2_K");
  });

  it("tree が複数ページでも全部集める（Link の next を辿る）", async () => {
    hf.behavior.treePageSize = 2;
    const res = await worker.api("/hf/files?repo=acme/tiny-GGUF");
    expect(res.body.items).toHaveLength(5);
    const pages = hf.hfRequests.filter((request) => request.url.includes("/tree/main"));
    expect(pages.length).toBeGreaterThan(1);
  });

  it("GGUF 以外も出す。分割の safetensors もまとめ、モデル本体を先に並べる", async () => {
    const res = await worker.api("/hf/files?repo=acme/split-only");
    expect(res.body.items.map((item: any) => item.name)).toEqual(["model-00001-of-00002.safetensors", "README.md", "vae/config.json"]);
    expect(res.body.items[0]).toMatchObject({ split: true, complete: true, sizeBytes: data.length * 2 });
  });

  it("先頭がない分割は complete: false", async () => {
    const res = await worker.api("/hf/files?repo=acme/lonely-GGUF");
    expect(res.body.items[0]).toMatchObject({ split: true, complete: false });
  });

  it("ない repo は 404、形が不正なら 400", async () => {
    expect((await worker.api("/hf/files?repo=acme/none")).status).toBe(404);
    for (const repo of ["..%2Fx", "a", "a/b/c", "../etc", "/abs/path", "a/.."]) {
      expect((await worker.api(`/hf/files?repo=${repo}`)).status, repo).toBe(400);
    }
  });
});

describe("入力の検査（パストラバーサル）", () => {
  const bad = ["../evil.gguf", "/etc/x.gguf", "a/../../x.gguf", "a\\b.gguf", "a//b.gguf", ""];
  it.each(bad)("ファイル名 %j を拒否する", async (file) => {
    for (const kind of ["model", "image"]) {
      const res = await worker.api("/downloads", { body: { repo: "acme/tiny-GGUF", files: [file], kind } });
      expect(res.status).toBe(400);
    }
  });
  it("model と adapter は GGUF 以外を受けない", async () => {
    for (const kind of ["model", "adapter"]) {
      const res = await worker.api("/downloads", { body: { repo: "acme/tiny-GGUF", files: ["README.md"], kind } });
      expect(res.status).toBe(400);
    }
  });
  it("リポジトリ全体は保存だけの file に限る", async () => {
    expect((await worker.api("/downloads", { body: { repo: "acme/tiny-GGUF", kind: "model" } })).status).toBe(400);
  });
  it.each(["../x/y", "acme/../x", "/abs/x", "acme", "a b/c"])("repo %j を拒否する", async (repo) => {
    const res = await worker.api("/downloads", { body: { repo, files: ["tiny-Q4_K_M.gguf"], kind: "model" } });
    expect(res.status).toBe(400);
  });
  it("ツリーにないファイルは 400", async () => {
    const res = await worker.api("/downloads", { body: { repo: "acme/tiny-GGUF", files: ["nothing.gguf"], kind: "model" } });
    expect(res.status).toBe(400);
  });
  it("拒否した後に DL の行も作らない", async () => {
    await worker.api("/downloads", { body: { repo: "acme/tiny-GGUF", files: ["../evil.gguf"], kind: "model" } });
    expect((await worker.api("/downloads")).body.items).toEqual([]);
  });
});

describe("API-094 HF トークン", () => {
  const file = () => path.join(worker.dir, "secrets", "hf-token");

  it("GET は { has } だけ返し、PUT でトークンの値は返らない", async () => {
    expect((await worker.api("/local/hf-token")).body).toEqual({ has: false });
    const put = await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_secret" } });
    expect(put.body).toEqual({ has: true });
    const get = await worker.api("/local/hf-token");
    expect(get.body).toEqual({ has: true });
    expect(JSON.stringify([put.body, get.body])).not.toContain("hf_secret");
  });

  it("ファイルの権限は 600（既存ファイルを上書きしても）", async () => {
    await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_secret" } });
    expect(readFileSync(file(), "utf8")).toBe("hf_secret");
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_other" } });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("null で消える。改行や空の値は 400", async () => {
    await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_secret" } });
    expect((await worker.api("/local/hf-token", { method: "PUT", body: { token: null } })).body).toEqual({ has: false });
    expect(existsSync(file())).toBe(false);
    for (const token of ["", "a b", "a\nb", 5]) {
      expect((await worker.api("/local/hf-token", { method: "PUT", body: { token } })).status, String(token)).toBe(400);
    }
  });
});

describe("ゲート付きリポジトリ", () => {
  const body = { repo: "acme/gated-GGUF", files: ["g-Q4_K_M.gguf"], kind: "model" };

  it("トークンなしは 401 AUTH_REQUIRED_UPSTREAM", async () => {
    const res = await worker.api("/downloads", { body });
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: "AUTH_REQUIRED_UPSTREAM", message: "ゲート付きリポジトリ。設定で HF トークンが必要" });
  });

  it("間違ったトークンも 401", async () => {
    await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_wrong" } });
    expect((await worker.api("/downloads", { body })).status).toBe(401);
  });

  it("正しいトークンなら受け付ける。トークンは HF にだけ付き、CDN へのリダイレクトでは落ちる", async () => {
    await worker.api("/local/hf-token", { method: "PUT", body: { token: "hf_secret" } });
    const res = await worker.api("/downloads", { body });
    expect(res.status).toBe(202);
    expect(hf.hfRequests.some((request) => request.authorization === "Bearer hf_secret")).toBe(true);
    const resolved = hf.hfRequests.filter((request) => request.url.includes("/resolve/"));
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every((request) => request.authorization === "Bearer hf_secret")).toBe(true);
    expect(hf.cdnRequests.length).toBeGreaterThan(0);
    expect(hf.cdnRequests.every((request) => request.authorization === undefined)).toBe(true);
  });
});
