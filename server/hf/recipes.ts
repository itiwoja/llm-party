/** 複数のリポジトリの部品を束ねて1つのモデルにするレシピ（D-73, D-78, ADR-010） */
export interface RecipePart { key: string; repo: string; file: string }

/** parts の先頭が主の部品。models.path になる */
export const MOSS_IMAGE: RecipePart[] = [
  { key: "diffusion", repo: "unsloth/MOSS-Image-SFT-GGUF", file: "MOSS-Image-SFT-UD-Q4_K_XL.gguf" },
  { key: "llm", repo: "unsloth/Qwen3.5-9B-GGUF", file: "Qwen3.5-9B-Q8_0.gguf" },
  { key: "vae", repo: "unsloth/MOSS-Image-SFT-FP8", file: "vae/diffusion_pytorch_model.safetensors" },
  { key: "tokenizer", repo: "unsloth/MOSS-Image-SFT-FP8", file: "tokenizer/tokenizer.json" },
];

/** 8GB の GPU で動く組み合わせ（D-78, ADR-013）。acestep.cpp は同じフォルダから読むので、リポジトリは1つ */
const ACE_REPO = "Serveurperso/ACE-Step-1.5-GGUF";
export const ACE_STEP: RecipePart[] = [
  { key: "dit", repo: ACE_REPO, file: "acestep-v15-turbo-Q8_0.gguf" },
  { key: "lm", repo: ACE_REPO, file: "acestep-5Hz-lm-1.7B-Q8_0.gguf" },
  { key: "textEncoder", repo: ACE_REPO, file: "Qwen3-Embedding-0.6B-Q8_0.gguf" },
  { key: "vae", repo: ACE_REPO, file: "vae-BF16.gguf" },
];

export type RecipeKind = "image-set" | "music-set";

export interface Recipe { id: "moss-image" | "ace-step"; name: string; kind: RecipeKind; parts: RecipePart[] }

export const RECIPES: Recipe[] = [
  { id: "moss-image", name: "MOSS-Image", kind: "image-set", parts: MOSS_IMAGE },
  { id: "ace-step", name: "ACE-Step 1.5", kind: "music-set", parts: ACE_STEP },
];
