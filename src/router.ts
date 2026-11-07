import { useSyncExternalStore } from "react";

/** 01_ia のルート。ハッシュだけで切り替える（URL の #token= は main.tsx が先に読み取って消す） */
export type Route =
  | { page: "threads"; id?: string; projectId?: string }
  | { page: "music"; id?: string }
  | { page: "setup" }
  | { page: "models" }
  | { page: "presets"; id?: string }
  | { page: "evals"; id?: string }
  | { page: "runs"; id: string }
  | { page: "compare"; id: string }
  | { page: "settings" };

export function parseRoute(hash: string): Route {
  const [first = "", second, third] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  switch (first) {
    case "music": return { page: "music", id: second || undefined };
    case "setup": return { page: "setup" };
    case "models": return { page: "models" };
    case "presets": return { page: "presets", id: second || undefined };
    case "evals": return second && third === "compare" ? { page: "compare", id: second } : { page: "evals", id: second || undefined };
    case "runs": return second ? { page: "runs", id: second } : { page: "evals" };
    case "settings": return { page: "settings" };
    default:
      // #/threads/new/<id>：そのプロジェクトで新しいスレッドを始める入力画面
      if (first === "threads" && second === "new" && third) return { page: "threads", id: undefined, projectId: third };
      return { page: "threads", id: first === "threads" ? second || undefined : undefined };
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** ハッシュ文字列を返す（文字列なら再描画の比較が値で済む） */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => location.hash);
}

export function useRoute(): Route {
  const hash = useHash();
  return parseRoute(hash);
}

/** `navigate("/threads/abc")`。replace なら履歴を積まない */
export function navigate(path: string, replace = false): void {
  const hash = `#${path}`;
  if (replace) history.replaceState(null, "", hash);
  else location.hash = hash;
  if (replace) window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export const hrefOf = (path: string) => `#${path}`;
