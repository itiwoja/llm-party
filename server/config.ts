import path from "node:path";

export interface LocalConfig {
  port: number;
  dataDir: string;
  llamaBin: string | null;
  /** sd-server（画像生成）の場所。未設定なら画像生成は使えない */
  sdBin: string | null;
  backend: "cuda" | "vulkan" | "cpu";
}

/** localhost 段階の環境変数を読む（12 起動のしかた） */
export function loadLocalConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const port = Number(env.LLM_PARTY_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`LLM_PARTY_PORT が正しくありません: ${env.LLM_PARTY_PORT}`);
  }
  const backend = env.LLM_PARTY_BACKEND ?? "cuda";
  if (backend !== "cuda" && backend !== "vulkan" && backend !== "cpu") {
    throw new Error(`LLM_PARTY_BACKEND が正しくありません: ${backend}`);
  }
  return {
    port,
    dataDir: path.resolve(env.LLM_PARTY_DATA_DIR ?? "data"),
    llamaBin: env.LLM_PARTY_LLAMA_BIN || null,
    sdBin: env.LLM_PARTY_SD_BIN || null,
    backend,
  };
}
