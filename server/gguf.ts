import { closeSync, openSync, readSync, statSync } from "node:fs";
import { ApiError } from "./http-error";
import { thinkingSupport, type ThinkingSupport } from "./thinking";

export interface GgufInfo extends ThinkingSupport {
  type: string;
  architecture: string;
  name: string | null;
  quantization: string | null;
  trainContext: number | null;
  /** 層の数。-ngl の計算に使う */
  blockCount: number | null;
  sizeBytes: number;
}

/** 先読みの補助部分（MTP）だけのファイルを登録・読み込みしようとしたときの文言 */
export const MTP_ONLY_MESSAGE = "先読みの補助部分（MTP）だけの GGUF。単体では動かないので、同じリポジトリのモデル本体の GGUF を使う";

/** MoE なのに専門家の重みが入っていない、別のツール向けに一部だけ切り出した GGUF の文言 */
export const PARTIAL_MESSAGE = "MoE の専門家の重みが入っていない、一部だけの GGUF。llama.cpp では読めないので、このアプリでは使えない";

/** 登録・読み込みを止める理由。使えるファイルなら null */
export function unusableReason(info: Pick<GgufInfo, "type">): string | null {
  if (info.type === "mtp") return MTP_ONLY_MESSAGE;
  if (info.type === "partial") return PARTIAL_MESSAGE;
  return null;
}

const FIXED_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const STRING = 8;
const ARRAY = 9;

/** general.file_type の値（llama.cpp の LLAMA_FTYPE） */
const FILE_TYPES: Record<number, string> = {
  1: "F16", 7: "Q8_0", 12: "Q4_K_S", 14: "Q5_K_S", 15: "Q4_K_M", 17: "Q5_K_M", 18: "Q6_K", 32: "BF16",
};

/** 先頭から順に読む。語彙の配列で数 MB あるので、全体を読み込まない */
class Reader {
  private chunk = Buffer.alloc(0);
  private start = 0;
  pos = 0;

  constructor(private fd: number, private size: number) {}

  private ensure(n: number): void {
    if (this.pos + n > this.size) throw new RangeError("GGUF が途中で終わっています");
    if (this.pos >= this.start && this.pos + n <= this.start + this.chunk.length) return;
    this.chunk = Buffer.alloc(Math.max(n, 1 << 20));
    const read = readSync(this.fd, this.chunk, 0, this.chunk.length, this.pos);
    this.chunk = this.chunk.subarray(0, read);
    this.start = this.pos;
  }

  bytes(n: number): Buffer {
    this.ensure(n);
    const offset = this.pos - this.start;
    this.pos += n;
    return this.chunk.subarray(offset, offset + n);
  }

  u32 = () => this.bytes(4).readUInt32LE();
  u64 = () => Number(this.bytes(8).readBigUInt64LE());
  string = () => this.bytes(this.u64()).toString("utf8");
  skip = (n: number) => { this.pos += n; };

  value(type: number): string | number | undefined {
    if (type === STRING) return this.string();
    if (type === ARRAY) {
      const itemType = this.u32();
      const count = this.u64();
      if (itemType in FIXED_SIZE) this.skip(FIXED_SIZE[itemType] * count);
      else for (let i = 0; i < count; i += 1) this.value(itemType);
      return undefined;
    }
    const size = FIXED_SIZE[type];
    if (size === undefined) throw new RangeError(`未知の型 ${type}`);
    const raw = this.bytes(size);
    if (type === 4) return raw.readUInt32LE();
    if (type === 5) return raw.readInt32LE();
    if (type === 10) return Number(raw.readBigUInt64LE());
    return undefined;
  }
}

export function readGguf(file: string): GgufInfo {
  const sizeBytes = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const reader = new Reader(fd, sizeBytes);
    if (sizeBytes < 24 || reader.bytes(4).toString("latin1") !== "GGUF") {
      throw new ApiError("INVALID_GGUF", "GGUF ファイルではありません");
    }
    reader.u32(); // 版
    const tensorCount = reader.u64();
    const count = reader.u64();
    const kv = new Map<string, string | number>();
    for (let i = 0; i < count; i += 1) {
      const key = reader.string();
      const value = reader.value(reader.u32());
      if (value !== undefined) kv.set(key, value);
    }
    const architecture = kv.get("general.architecture");
    if (typeof architecture !== "string") {
      throw new ApiError("INVALID_GGUF", "GGUF の general.architecture がありません");
    }
    const fileType = kv.get("general.file_type");
    const context = kv.get(`${architecture}.context_length`);
    const blocks = kv.get(`${architecture}.block_count`);
    const name = kv.get("general.name");
    const type = kv.get("general.type");
    const template = kv.get("tokenizer.chat_template");
    const nextn = kv.get(`${architecture}.nextn_predict_layers`);
    const experts = kv.get(`${architecture}.expert_count`);
    const tensors = tensorNames(reader, tensorCount);
    const mtpOnly = typeof nextn === "number" && nextn > 0 && typeof blocks === "number"
      && !hasMainLayers(tensors, blocks - nextn);
    const partial = typeof experts === "number" && experts > 0 && !tensors.some((tensor) => EXPERT_WEIGHT.test(tensor));
    return {
      type: mtpOnly ? "mtp" : partial ? "partial" : typeof type === "string" ? type : "model",
      architecture,
      name: typeof name === "string" ? name : null,
      quantization: typeof fileType === "number" ? (FILE_TYPES[fileType] ?? null) : null,
      trainContext: typeof context === "number" ? context : null,
      blockCount: typeof blocks === "number" ? blocks : null,
      sizeBytes,
      ...thinkingSupport(typeof template === "string" ? template : undefined),
    };
  } catch (error) {
    if (error instanceof RangeError) throw new ApiError("INVALID_GGUF", "GGUF を読めません");
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** テンソルの名前を全部読む。名前の後ろの次元・型・位置は飛ばす */
function tensorNames(reader: Reader, tensorCount: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < tensorCount; i += 1) {
    names.push(reader.string());
    const dims = reader.u32();
    reader.skip(8 * dims + 4 + 8); // 各次元・型・位置
  }
  return names;
}

/**
 * MoE の専門家の重み。まとめた形（ffn_down_exps.weight など）と、古い Mixtral の1つずつの形（ffn_down.0.weight）。
 * Strata 向けの GGUF のように、名前は同じでも .scale しかなく本体を別のファイルに置くものは当てはまらない
 */
const EXPERT_WEIGHT = /^blk\.\d+\.ffn_(?:(?:down|gate|up|gate_up)_exps|(?:down|gate|up)\.\d+)\.weight$/;

/**
 * MTP（先読みの補助部分）だけを切り出した GGUF は、ヘッダの block_count は本体と同じでも、
 * テンソルは最後の nextn 層しか持たない。本体の層（blk.0 〜 blk.(mainLayers-1)）が1つでもあれば本体とみなす
 */
function hasMainLayers(tensors: readonly string[], mainLayers: number): boolean {
  return tensors.some((tensor) => {
    const match = /^blk\.(\d+)\./.exec(tensor);
    return match !== null && Number(match[1]) < mainLayers;
  });
}
