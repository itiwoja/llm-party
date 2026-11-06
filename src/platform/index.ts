import { requestPath } from "./pathPrompt";

/** 画面が OS と接続に触る唯一の層。exe 段階で Electron の実装に差し替える（12 IPC の代わり） */
const STORAGE_KEY = "llm-party.token";

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** URL の #token= を読み取り、保存して URL から消す。画面の描画より先に呼ぶ */
export function captureTokenFromUrl(): void {
  const match = /^#token=([0-9a-f]+)$/.exec(location.hash);
  if (!match) return;
  try {
    localStorage.setItem(STORAGE_KEY, match[1]);
  } catch {
    // 保存できない環境では入力を求める
  }
  history.replaceState(null, "", location.pathname + location.search);
}

export function getConnection(): { baseUrl: string; token: string | null } {
  return { baseUrl: "/api", token: readStoredToken() };
}

export function setToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}

/** API-002。localhost 段階はパスの入力ダイアログ（CP-200）。やめたら null。正しいかは登録 API が確かめる */
export function pickFolder(): Promise<string | null> {
  return requestPath("folder");
}

/** API-003。localhost 段階はパスの入力ダイアログ（CP-201） */
export function pickFile(): Promise<string | null> {
  return requestPath("file");
}
