/** D-78 の長さ。サーバー（server/routes/music.ts）と同じ値 */
export const MUSIC_MIN_SECONDS = 10;
export const MUSIC_MAX_SECONDS = 240;
export const MUSIC_DEFAULT_SECONDS = 60;
export const INSTRUMENTAL = "[Instrumental]";

/** FR-024 の構成タグ。ボタンの見た目は語、挿入は [語] */
export const LYRIC_TAGS = ["Intro", "Verse", "Pre-Chorus", "Chorus", "Bridge", "Outro", "Instrumental Break"] as const;

export type MusicJob = "draft" | "track";
export type MusicPhase = "drafting" | "composing" | "rendering";

/** API-111 の一覧の1件 */
export interface TrackListItem {
  id: string;
  prompt: string;
  duration: number;
  createdAt: string | number;
}

/** API-112 */
export interface TrackDetail {
  id: string;
  prompt: string;
  lyrics: string;
  reasoning: string | null;
  duration: number;
  bpm: number | null;
  keyscale: string | null;
  modelName: string;
  seed: number;
  createdAt: string | number;
}

/** 入力途中の値は通し、確定した値だけを範囲に収める（MusicOptions と同じ考え） */
export function clampDuration(value: number): number {
  return Math.min(MUSIC_MAX_SECONDS, Math.max(MUSIC_MIN_SECONDS, Math.round(value) || MUSIC_DEFAULT_SECONDS));
}
