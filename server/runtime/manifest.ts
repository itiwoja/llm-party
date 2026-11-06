/**
 * llama-server の取得先（ADR-011）。版は固定する。版を上げるときはここだけ変える。
 * sha256 は GitHub Releases の digest（確認済み）。
 */
export const LLAMA_BUILD = "b12125";

export interface RuntimeAsset {
  name: string;
  size: number;
  sha256: string;
  url: string
}

export interface LlamaFlavor {
  id: "cuda" | "cpu";
  /** <データ>/runtime/llama/ の下のフォルダ名 */
  dirName: string;
  archive: RuntimeAsset;
  /** CUDA の cudart。展開後に .so を llama-server と同じフォルダへ置く */
  extras: RuntimeAsset[];
}

const RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}`;

function asset(name: string, size: number, sha256: string): RuntimeAsset {
  return { name, size, sha256, url: `${RELEASE_BASE}/${name}` };
}

export const LLAMA_FLAVORS: Record<LlamaFlavor["id"], LlamaFlavor> = {
  cuda: {
    id: "cuda",
    dirName: `${LLAMA_BUILD}-cuda12.8`,
    archive: asset(
      `llama-${LLAMA_BUILD}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
      188603888,
      "3a65d23e69b6c02ac6856a0a7465444e8c7c929e225169a287f4b960a16efc43",
    ),
    extras: [
      asset(
        `cudart-llama-${LLAMA_BUILD}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
        594371475,
        "75c830c6829f406e3f9219952d31c9698adfa716aa9e331220cb205369c8c074",
      ),
    ],
  },
  cpu: {
    id: "cpu",
    dirName: `${LLAMA_BUILD}-cpu`,
    archive: asset(
      `llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz`,
      23080676,
      "d23ae67c28cdae4b1fa5a4687442c787d0ef0e89d93512056e353b10495251ae",
    ),
    extras: [],
  },
};

/** 取得の合計の上限（判断 D5） */
export const MAX_INSTALL_BYTES = 1024 ** 3;
/** 1ファイルの DL の再試行回数（判断 D5） */
export const DOWNLOAD_RETRIES = 3;
