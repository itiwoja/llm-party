/** llama-server の SSE を1チャンクずつ JSON で返す（API-101） */
export async function* readChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const part of body) {
    buffer += decoder.decode(part, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") return;
      yield JSON.parse(payload) as ChatChunk;
    }
  }
}

export interface ChatChunk {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  timings?: { predicted_per_second?: number; cache_n?: number; prompt_n?: number; predicted_n?: number };
}
