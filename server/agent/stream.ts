import { type ChatChunk, readChatStream, type ToolCallDelta } from "../llama-stream";

export type { ToolCallDelta };

export interface AssembledToolCall {
  /** モデルが付けた呼び出し ID。なければ作る */
  id: string;
  name: string;
  /** つなげただけの文字列。JSON として壊れていることがある */
  arguments: string;
}

/** index ごとの断片をつなげて、並んだ順の呼び出しにする */
export class ToolCallAssembler {
  private calls = new Map<number, { id: string; name: string; arguments: string }>();

  add(deltas: ToolCallDelta[]): void {
    for (const delta of deltas) {
      const call = this.calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
      if (delta.id) call.id = delta.id;
      if (delta.function?.name) call.name += delta.function.name;
      if (delta.function?.arguments) call.arguments += delta.function.arguments;
      this.calls.set(delta.index, call);
    }
  }

  result(makeId: () => string): AssembledToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ ...call, id: call.id || makeId() }));
  }
}

/** モデルに渡すメッセージ（OpenAI 形式） */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface Generation {
  content: string;
  reasoning: string;
  toolCalls: AssembledToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** max_tokens に達した（D-61） */
  truncated: boolean;
}

export interface CompletionRequest {
  baseUrl: string;
  apiKey: string;
  signal: AbortSignal;
  /** messages・tools・生成設定・lora など、そのまま JSON で送るもの */
  body: Record<string, unknown>;
  makeId: () => string;
  onDelta?(delta: { content?: string; reasoning?: string }): void;
  /** usage か timings を含むチャンクごと */
  onChunk?(chunk: ChatChunk, usage: Generation["usage"]): void;
}

/** POST /v1/chat/completions（API-101）を stream で呼び、1回分の応答にまとめる。会話にも評価にも使う */
export async function streamCompletion(request: CompletionRequest): Promise<Generation> {
  const res = await fetch(`${request.baseUrl}/v1/chat/completions`, {
    method: "POST",
    signal: request.signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}` },
    body: JSON.stringify({ ...request.body, stream: true, stream_options: { include_usage: true }, timings_per_token: true }),
  });
  if (!res.ok || !res.body) throw new Error(`llama-server が ${res.status} を返しました: ${await res.text()}`);

  const result: Generation = { content: "", reasoning: "", toolCalls: [], truncated: false };
  const assembler = new ToolCallAssembler();
  for await (const chunk of readChatStream(res.body)) {
    const choice = chunk.choices?.[0];
    const text = choice?.delta?.content ?? "";
    const thought = choice?.delta?.reasoning_content ?? "";
    if (text || thought) {
      result.content += text;
      result.reasoning += thought;
      request.onDelta?.({ ...(text ? { content: text } : {}), ...(thought ? { reasoning: thought } : {}) });
    }
    if (choice?.delta?.tool_calls) assembler.add(choice.delta.tool_calls);
    if (choice?.finish_reason === "length") result.truncated = true;
    if (chunk.usage) result.usage = chunk.usage;
    request.onChunk?.(chunk, result.usage);
  }
  result.toolCalls = assembler.result(request.makeId);
  return result;
}
