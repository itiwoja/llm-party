/**
 * Hugging Face のリポジトリのうち、アプリで使えると確定したものを見分ける（D-89）。
 * 分からないものは使えない側に倒す。
 */

/**
 * チャットに使える GGUF の形式。HF の GGUF 上位（2026-11-07）のうち、チャットテンプレートがあり、
 * 手元の llama-server（b12125 の llama.dll）が名前を持つもの。音声・OCR・埋め込み・LoRA 専用の形式は入れない。
 * llama-server を上げたら見直す
 */
const CHAT_ARCHITECTURES: ReadonlySet<string> = new Set([
  "afmoe", "apertus", "bailingmoe3", "chatglm", "clef", "clover_moe", "cohere2", "cohere2moe", "command-r",
  "deepseek2", "deepseek4", "deepseek41", "dflash", "ernie4_5-moe", "exaone4", "flint", "gemma2", "gemma3", "gemma3n", "gemma4",
  "glm-dsa", "glm4", "glm4moe", "glm5-next", "gpt-oss", "granite", "granitemoe", "hunyuan-dense", "hunyuan_vl", "hy_v3",
  "k2-horizon", "kimi-k3", "kimi-linear", "kolibri1", "laguna", "lfm2", "lfm2moe", "lfm3", "llama", "llama4",
  "maple", "mellum", "mimo2", "minimax-m2", "minimax-m3", "mistral-large4", "mistral3", "mistral4", "muse-glimmer", "muse-spark",
  "nanbeige", "nemotron_h", "nemotron_h_moe", "olmo2", "olmoe", "phi3", "qwen2", "qwen2vl", "qwen3", "qwen35", "qwen35moe",
  "qwen3moe", "qwen3next", "qwen3vl", "qwen3vlmoe", "qwen4exp", "seed_oss", "smollm3", "spark2_5", "stablelm", "starcoder", "step35",
]);

/** sd-cli が1つの .safetensors で読める組み立て */
const IMAGE_PIPELINES: ReadonlySet<string> = new Set(["StableDiffusionPipeline", "StableDiffusionXLPipeline"]);

const CHAT_TAGS: ReadonlySet<string> = new Set(["text-generation", "image-text-to-text"]);

/** 分割していない、リポジトリ直下の .safetensors。サブフォルダは部品（unet/ や vae/）なので外す */
export const isRootSafetensors = (name: string) => /^[^/]+\.safetensors$/i.test(name) && !/-\d{5}-of-\d{5}\.safetensors$/i.test(name);

/** 画像生成の部品（テキストエンコーダ・プロンプト書き換え）。GGUF が読めてもチャット用ではない */
const isImagePart = (repo: string, tags: string[]) => /text[-_ ]?encoder/i.test(repo) || tags.some((tag) => tag === "text-encoder" || tag.startsWith("prompt-"));

interface RepoInfo {
  id?: unknown;
  tags?: string[];
  pipeline_tag?: string | null;
  gguf?: { architecture?: unknown; chat_template?: unknown };
  config?: { diffusers?: { _class_name?: unknown } };
  siblings?: { rfilename?: unknown }[];
}

/** 使える用途。確定しないものは null */
export function usableAs(item: RepoInfo): "chat" | "image" | null {
  const tag = item.pipeline_tag ?? null;
  const files = (item.siblings ?? []).map((file) => String(file.rfilename ?? ""));
  const { architecture, chat_template: template } = item.gguf ?? {};
  if (
    tag !== null && CHAT_TAGS.has(tag)
    && !isImagePart(String(item.id ?? ""), item.tags ?? [])
    && typeof architecture === "string" && CHAT_ARCHITECTURES.has(architecture)
    && Boolean(template)
    && files.some((file) => file.toLowerCase().endsWith(".gguf"))
  ) return "chat";
  const pipeline = item.config?.diffusers?._class_name;
  if (tag === "text-to-image" && typeof pipeline === "string" && IMAGE_PIPELINES.has(pipeline) && files.some(isRootSafetensors)) return "image";
  return null;
}

const HEADER_LIMIT = 64 * 1024 * 1024;

/** safetensors の頭の長さ（先頭 8 バイト）。読めない値は null */
export function headerLength(prefix: Buffer): number | null {
  if (prefix.length < 8) return null;
  const length = Number(prefix.readBigUInt64LE(0));
  return length > 0 && length <= HEADER_LIMIT ? length : null;
}

/** 頭の JSON から、UNet・VAE・テキストエンコーダが1つのファイルに揃っているかを見る。LoRA や VAE だけのファイルを外す */
export function isCheckpointHeader(header: Buffer): boolean {
  let keys: string[];
  try {
    keys = Object.keys(JSON.parse(header.toString("utf8")) as object);
  } catch {
    return false;
  }
  const has = (...prefixes: string[]) => keys.some((key) => prefixes.some((prefix) => key.startsWith(prefix)));
  return has("model.diffusion_model.") && has("first_stage_model.") && has("cond_stage_model.", "conditioner.");
}
