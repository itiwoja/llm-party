import type { EngineManager } from "./engine";
import type { EventBus } from "./events";
import { ApiError } from "./http-error";
import { readChatStream } from "./llama-stream";
import type { Store } from "./store";

const ENGINE_STOPPED = "推論エンジンが停止しました";
/** 画面の数字の更新間隔。毎トークン送ると無駄が多い */
const USAGE_INTERVAL_MS = 500;
/** 1回の生成の上限（D-61）。思考が終わらないときに止める */
const MAX_TOKENS = 8192;

/** FR-005。生成は同時に1つだけ（D-60） */
export class ChatService {
  private active: { turnId: string; abort: AbortController; done: Promise<void> } | null = null;

  constructor(private store: Store, private engine: EngineManager, private bus: EventBus) {}

  send(threadId: string, presetId: string, content: string): { turnId: string; status: "running" } {
    if (!this.store.getThread(threadId)) throw new ApiError("NOT_FOUND", "スレッドがありません");
    if (!this.store.getPreset(presetId)) throw new ApiError("NOT_FOUND", "プリセットがありません");
    if (this.active) throw new ApiError("BUSY", "別の生成が動いています");

    const turnId = this.store.beginTurn(threadId, presetId, content);
    const abort = new AbortController();
    const done = this.run(turnId, threadId, presetId, abort.signal).finally(() => {
      this.active = null;
    });
    this.active = { turnId, abort, done };
    return { turnId, status: "running" };
  }

  cancel(turnId: string): void {
    if (this.active?.turnId !== turnId) throw new ApiError("CONFLICT", "このターンは動いていません");
    this.active.abort.abort();
  }

  /** 動いているターンを止めて、終わるのを待つ（終了時） */
  async shutdown(): Promise<void> {
    const active = this.active;
    active?.abort.abort();
    await active?.done;
  }

  private async run(turnId: string, threadId: string, presetId: string, signal: AbortSignal): Promise<void> {
    const preset = this.store.getPreset(presetId)!;
    const model = this.store.getModel(preset.modelId)!;
    const adapters = this.store.presetAdapters(presetId);
    const messageId = this.store.addMessage({ threadId, turnId, role: "assistant", content: "" });

    let content = "";
    let reasoning = "";
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
    let lastUsageAt = 0;
    let truncated = false;

    const finish = (status: "completed" | "cancelled" | "failed", error?: string) => {
      this.store.updateMessage(messageId, content, reasoning || null);
      this.store.finishTurn(turnId, status, { promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, error });
      this.bus.publish("turn.finished", { turnId, status, ...(error ? { error } : {}), ...(truncated ? { truncated } : {}) });
    };

    try {
      await this.engine.load({
        presetId,
        modelPath: model.path,
        contextSize: preset.contextSize,
        adapterPaths: adapters.map((adapter) => adapter.path),
      });
      signal.throwIfAborted();

      const { sampling, systemPrompt, thinking, contextSize } = preset;
      const history = this.store.conversation(threadId);
      const res = await fetch(`${this.engine.baseUrl}/v1/chat/completions`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.engine.apiKey}` },
        body: JSON.stringify({
          messages: systemPrompt ? [{ role: "system", content: systemPrompt }, ...history] : history,
          max_tokens: MAX_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
          timings_per_token: true,
          temperature: sampling.temperature,
          top_p: sampling.topP,
          top_k: sampling.topK,
          min_p: sampling.minP,
          presence_penalty: sampling.presencePenalty,
          repeat_penalty: sampling.repeatPenalty,
          ...(adapters.length ? { lora: adapters.map((adapter, id) => ({ id, scale: adapter.scale })) } : {}),
          chat_template_kwargs: { enable_thinking: thinking },
        }),
      });
      if (!res.ok || !res.body) throw new Error(`llama-server が ${res.status} を返しました: ${await res.text()}`);

      for await (const chunk of readChatStream(res.body)) {
        const delta = chunk.choices?.[0]?.delta;
        const text = delta?.content ?? "";
        const thought = delta?.reasoning_content ?? "";
        if (text || thought) {
          content += text;
          reasoning += thought;
          this.bus.publish("turn.delta", { turnId, messageId, ...(text ? { content: text } : {}), ...(thought ? { reasoning: thought } : {}) });
        }
        if (chunk.choices?.[0]?.finish_reason === "length") truncated = true;
        if (chunk.usage) usage = chunk.usage;
        if (chunk.usage || (chunk.timings && Date.now() - lastUsageAt >= USAGE_INTERVAL_MS)) {
          lastUsageAt = Date.now();
          this.bus.publish("turn.usage", {
            turnId,
            usedTokens: usage
              ? usage.prompt_tokens + usage.completion_tokens
              : (chunk.timings?.cache_n ?? 0) + (chunk.timings?.prompt_n ?? 0) + (chunk.timings?.predicted_n ?? 0),
            contextSize,
            tokensPerSecond: chunk.timings?.predicted_per_second,
          });
        }
      }
      finish("completed");
    } catch (error) {
      if (signal.aborted) {
        finish("cancelled");
      } else if (error instanceof ApiError) {
        finish("failed", error.message);
      } else if (await this.engine.healthy()) {
        finish("failed", error instanceof Error ? error.message : String(error));
      } else {
        finish("failed", ENGINE_STOPPED);
      }
    }
  }
}
