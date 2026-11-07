import { useSyncExternalStore } from "react";
import { PG10 } from "./copy";
import { INSTRUMENTAL, MUSIC_DEFAULT_SECONDS, type MusicJob, type MusicPhase } from "./types";

/** D-81：編集中の内容。アプリのメモリに持つので、画面を行き来しても残り、再読み込みで消える */
export interface MusicDraft { prompt: string; lyrics: string; duration: number; instrumental: boolean }

export interface MusicState extends MusicDraft {
  job: MusicJob | null;
  phase: MusicPhase | null;
  /** LM の思考（それまでの全文） */
  reasoning: string;
  /** 直近の失敗の文。次の実行を始めると消える */
  error: string;
  /** 曲が出来上がるたびに増える。一覧の読み直しの合図 */
  completedSeq: number;
}

const EMPTY_DRAFT: MusicDraft = { prompt: "", lyrics: "", duration: MUSIC_DEFAULT_SECONDS, instrumental: false };
const INITIAL: MusicState = { ...EMPTY_DRAFT, job: null, phase: null, reasoning: "", error: "", completedSeq: 0 };

/** サーバーが「評価の実行中です」と返したときは、FR-025 の既存の文言をそのまま出す */
const EVAL_BUSY_MESSAGE = "評価の実行中です";

let state: MusicState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<MusicState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** 作り直し（FR-026）：曲の内容を編集中の内容にする。[Instrumental] は歌なしのスイッチに戻す */
export function draftFromTrack(track: { prompt: string; lyrics: string; duration: number }): MusicDraft {
  const instrumental = track.lyrics.trim() === INSTRUMENTAL;
  return { prompt: track.prompt, lyrics: instrumental ? "" : track.lyrics, duration: track.duration, instrumental };
}

/** 作り直しの前に確認する内容があるか */
export const hasDraftContent = (s: Pick<MusicDraft, "prompt" | "lyrics">): boolean => s.prompt.trim() !== "" || s.lyrics.trim() !== "";

/** 生成のリクエストに載せる歌詞。歌なしは [Instrumental]、空は作詞をサーバーに任せる */
export function lyricsForRequest(s: Pick<MusicDraft, "lyrics" | "instrumental">): string | undefined {
  if (s.instrumental) return INSTRUMENTAL;
  return s.lyrics.trim() === "" ? undefined : s.lyrics;
}

export const musicStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): MusicState => state,

  setDraft(patch: Partial<MusicDraft>): void {
    set(patch);
  },

  /** POST の前に実行中にしておく。イベントが POST の応答より先に届いても壊れない */
  start(job: MusicJob): void {
    set({ job, phase: job === "draft" ? "drafting" : "composing", reasoning: "", error: "" });
  },

  /** POST が失敗したとき。イベントですでに状態が変わっていたら戻さない */
  startFailed(job: MusicJob, err: { code?: string; message: string }): void {
    const message = err.code === "BUSY" && err.message !== EVAL_BUSY_MESSAGE ? PG10.busy : err.message;
    if (state.job === job) set({ job: null, phase: null, reasoning: "", error: message });
    else set({ error: message });
  },

  /** 起動時に GET /music/status で実行中の状態を戻す。先にイベントが届いていたらそちらを優先する */
  restore(status: { status: "idle" | "drafting" | "composing" | "rendering"; reasoning?: string }): void {
    if (state.job || status.status === "idle") return;
    set({ job: status.status === "drafting" ? "draft" : "track", phase: status.status, reasoning: status.reasoning ?? "", error: "" });
  },

  /** `music` イベント（API-099）を受ける。曲が出来上がったら、その曲の id を返す */
  apply(data: { job: MusicJob; status: string; phase?: MusicPhase; reasoning?: string; lyrics?: string; trackId?: string; error?: string }): string | null {
    switch (data.status) {
      case "progress":
        set({ job: data.job, phase: data.phase ?? state.phase, reasoning: data.reasoning ?? state.reasoning, error: "" });
        return null;
      case "completed":
        if (data.job === "draft") {
          set({ job: null, phase: null, reasoning: "", lyrics: data.lyrics ?? state.lyrics });
          return null;
        }
        // 内容は曲に保存済みで「作り直す」で戻せるので、編集中は空に戻す
        set({ ...EMPTY_DRAFT, job: null, phase: null, reasoning: "", error: "", completedSeq: state.completedSeq + 1 });
        return data.trackId ?? null;
      case "failed":
        // 編集中の内容は変えない
        set({ job: null, phase: null, reasoning: "", error: data.job === "draft" ? PG10.draftFailed : PG10.trackFailed });
        return null;
      case "cancelled":
        set({ job: null, phase: null, reasoning: "", error: "" });
        return null;
      default:
        return null;
    }
  },

  /** テスト用 */
  reset(): void {
    state = INITIAL;
    listeners.forEach((l) => l());
  },
};

export function useMusicState(): MusicState {
  return useSyncExternalStore(musicStore.subscribe, musicStore.get);
}
