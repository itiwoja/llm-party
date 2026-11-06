/** 複数のリポジトリの部品を束ねて1つの画像モデルにするレシピ（D-73, ADR-010） */
export interface RecipePart { key: "diffusion" | "llm" | "vae" | "tokenizer"; repo: string; file: string }

export const MOSS_IMAGE: RecipePart[] = [
  { key: "diffusion", repo: "unsloth/MOSS-Image-SFT-GGUF", file: "MOSS-Image-SFT-UD-Q4_K_XL.gguf" },
  { key: "llm", repo: "unsloth/Qwen3.5-9B-GGUF", file: "Qwen3.5-9B-Q8_0.gguf" },
  { key: "vae", repo: "unsloth/MOSS-Image-SFT-FP8", file: "vae/diffusion_pytorch_model.safetensors" },
  { key: "tokenizer", repo: "unsloth/MOSS-Image-SFT-FP8", file: "tokenizer/tokenizer.json" },
];

export interface Recipe { id: "moss-image"; name: string; parts: RecipePart[] }

export const RECIPES: Recipe[] = [{ id: "moss-image", name: "MOSS-Image", parts: MOSS_IMAGE }];
