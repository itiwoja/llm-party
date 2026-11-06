export type PathKind = "folder" | "file";
export interface PathRequest { id: number; kind: PathKind; resolve(path: string | null): void }

let current: PathRequest | null = null;
let nextId = 0;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export const pathPromptStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: () => current,
  /** ダイアログを閉じる。path が null ならやめた */
  settle(path: string | null): void {
    const request = current;
    current = null;
    emit();
    request?.resolve(path);
  },
};

export function requestPath(kind: PathKind): Promise<string | null> {
  // 開いたまま次を求められたら前のはやめた扱いにする
  pathPromptStore.settle(null);
  return new Promise((resolve) => {
    current = { id: ++nextId, kind, resolve };
    emit();
  });
}
