/** 検索のジャンルと、HF の pipeline_tag の対応。1つのジャンルに複数あるときは別々に検索して混ぜる（HF は pipeline_tag を1つしか受けない） */
export const GENRES = {
  all: [],
  chat: ["text-generation", "image-text-to-text"],
  image: ["text-to-image"],
  video: ["text-to-video"],
  music: ["text-to-audio"],
  speech: ["text-to-speech"],
  transcribe: ["automatic-speech-recognition"],
  embedding: ["feature-extraction", "sentence-similarity"],
} as const satisfies Record<string, readonly string[]>;

export type Genre = keyof typeof GENRES;

export const GENRE_NAMES = Object.keys(GENRES) as [Genre, ...Genre[]];

/** llama-server で動かせるのは GGUF だけなので、チャットのジャンルは GGUF に絞る */
export const GGUF_ONLY_GENRES: readonly Genre[] = ["chat"];
