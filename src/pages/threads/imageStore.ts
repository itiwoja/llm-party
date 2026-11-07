import { useSyncExternalStore } from "react";

export interface ImageJob { threadId: string; prompt: string; modelId: string }
export interface ImageFailure { threadId: string; prompt: string; error: string }

export interface ImageState {
  job: ImageJob | null;
  /** 直近の失敗。依頼の文は DB に残らないので、次の生成を始めるまで画面に出す */
  failure: ImageFailure | null;
}

export type ImageStatus = { status: "idle" } | ({ status: "running" } & ImageJob);

const INITIAL: ImageState = { job: null, failure: null };

let state: ImageState = INITIAL;
/** 状態を確かめている間に結果が届いたら、古い status で実行中へ戻さない */
let finishedSeq = 0;
const listeners = new Set<() => void>();

function set(next: ImageState): void {
  state = next;
  listeners.forEach((l) => l());
}

/** D-84：画像生成の実行状態。ThreadsPage は画面を移ると消えるので、Shell が持ち続ける形でここに置く */
export const imageStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): ImageState => state,
  finishedSeq: (): number => finishedSeq,

  /** POST の前に実行中にしておく。イベントが POST の応答より先に届いても壊れない */
  start(job: ImageJob): void {
    set({ job, failure: null });
  },

  /** POST が失敗したとき。文は入力欄に残り、エラーは画面が出す */
  startFailed(): void {
    set({ job: null, failure: null });
  },

  /** GET /images/status の結果。seq は問い合わせる前の finishedSeq */
  restore(status: ImageStatus, seq: number): void {
    if (state.job || seq !== finishedSeq || status.status === "idle") return;
    const { threadId, prompt, modelId } = status;
    set({ ...state, job: { threadId, prompt, modelId } });
  },

  /** `image` イベント（API-099）を受ける */
  apply(data: { threadId: string; status: string; error?: string }): void {
    if (data.status === "progress") return;
    finishedSeq += 1;
    const prompt = state.job?.threadId === data.threadId ? state.job.prompt : "";
    set({ job: null, failure: data.status === "failed" ? { threadId: data.threadId, prompt, error: data.error ?? "" } : state.failure });
  },

  /** テスト用 */
  reset(): void {
    finishedSeq = 0;
    set(INITIAL);
  },
};

export function useImageState(): ImageState {
  return useSyncExternalStore(imageStore.subscribe, imageStore.get);
}
