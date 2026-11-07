/** 検索の1回分。tag は pipeline_tag（HF は1つしか受けない）、filter は重ねると AND になるタグ */
export interface GenreQuery { tag: string; filters: readonly string[] }

const CHAT_QUERIES: GenreQuery[] = [{ tag: "text-generation", filters: ["gguf"] }, { tag: "image-text-to-text", filters: ["gguf"] }];
const image = (pipeline: string): GenreQuery => ({ tag: "text-to-image", filters: [`diffusers:${pipeline}`] });
const IMAGE_QUERIES = [image("StableDiffusionPipeline"), image("StableDiffusionXLPipeline")];

/** ジャンルごとの検索。結果は DL 数の順に混ぜてから、hf/usable.ts で使えると確定したものだけ残す（D-89） */
export const GENRES = {
  all: [...CHAT_QUERIES, ...IMAGE_QUERIES],
  chat: CHAT_QUERIES,
  image: IMAGE_QUERIES,
} as const satisfies Record<string, readonly GenreQuery[]>;

export type Genre = keyof typeof GENRES;

export const GENRE_NAMES = Object.keys(GENRES) as [Genre, ...Genre[]];

/** 用途ごとの HF のタグ。同じ意味で別のタグが使われているので、どれかが付いていれば出す（D-90） */
export const PURPOSES = {
  all: [],
  japanese: ["ja", "japanese"],
  coding: ["code", "coding"],
  roleplay: ["roleplay", "rp"],
} as const satisfies Record<string, readonly string[]>;

export type Purpose = keyof typeof PURPOSES;

export const PURPOSE_NAMES = Object.keys(PURPOSES) as [Purpose, ...Purpose[]];
