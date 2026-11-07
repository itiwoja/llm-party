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
    reader.u64(); // テンソル数
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
    return {
      type: typeof type === "string" ? type : "model",
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
