import { ApiError, SnitchError } from '../util/errors.js';
import { fetchWithRetry } from './retry.js';
import type { ChatOptions, LLMProvider, StreamEvent, WireToolCall } from './types.js';

/**
 * Yields the `data:` payloads of an SSE byte stream, handling events split
 * across arbitrary chunk boundaries. Stops at `[DONE]`.
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineAt: number;
    while ((newlineAt = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineAt).replace(/\r$/, '');
      buffer = buffer.slice(newlineAt + 1);
      if (!line.startsWith('data:')) continue; // ignore comments/blank keep-alives
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      if (payload) yield payload;
    }
  }
}

interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Accumulates streamed tool-call deltas (fragmented `arguments` keyed by
 * `index`) into complete WireToolCalls.
 */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, WireToolCall>();

  add(delta: ToolCallDelta): void {
    let call = this.byIndex.get(delta.index);
    if (!call) {
      call = { id: '', type: 'function', function: { name: '', arguments: '' } };
      this.byIndex.set(delta.index, call);
    }
    if (delta.id) call.id = delta.id;
    if (delta.function?.name) call.function.name += delta.function.name;
    if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
  }

  drain(): WireToolCall[] {
    const calls = [...this.byIndex.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    this.byIndex.clear();
    return calls;
  }
}

interface StreamChunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
  error?: { message?: string; code?: number };
}

export interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /**
   * Wire dialect. OpenRouter accepts `usage: {include}` and custom headers;
   * plain OpenAI rejects unknown params and wants `stream_options` instead.
   */
  flavor?: 'openrouter' | 'openai';
}

export class OpenRouterProvider implements LLMProvider {
  readonly model: string;
  readonly capabilities = { nativeTools: true, streaming: true };
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly flavor: 'openrouter' | 'openai';

  constructor(options: OpenRouterProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.flavor = options.flavor ?? 'openrouter';
    this.baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
  }

  private get label(): string {
    return this.flavor === 'openai' ? 'OpenAI' : 'OpenRouter';
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamEvent> {
    const response = await fetchWithRetry(
      () =>
        fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...(this.flavor === 'openrouter' ? { 'X-Title': 'Snitch' } : {}),
          },
          body: JSON.stringify({
            model: this.model,
            messages: options.messages,
            ...(options.tools?.length ? { tools: options.tools } : {}),
            stream: true,
            ...(this.flavor === 'openrouter'
              ? { usage: { include: true } }
              : { stream_options: { include_usage: true } }),
          }),
          signal: options.signal,
        }),
      { signal: options.signal, onRetry: options.onRetry },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 401) {
        const hint = this.flavor === 'openai' ? 'OPENAI_API_KEY' : 'SNITCH_API_KEY / OPENROUTER_API_KEY';
        throw new ApiError(401, `${this.label} rejected the API key (401). Check ${hint}.`);
      }
      throw new ApiError(response.status, `${this.label} error ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    if (!response.body) throw new SnitchError(`${this.label} returned an empty response body.`);

    yield* this.parseChunks(response.body);
  }

  private async *parseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
    const accumulator = new ToolCallAccumulator();
    let finishReason = 'stop';

    for await (const payload of parseSSE(body)) {
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue; // tolerate malformed keep-alive noise
      }
      if (chunk.error?.message) {
        throw new ApiError(chunk.error.code ?? 0, `${this.label} mid-stream error: ${chunk.error.message}`);
      }

      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) yield { type: 'text', delta: choice.delta.content };
      for (const delta of choice?.delta?.tool_calls ?? []) accumulator.add(delta);
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      if (chunk.usage) {
        yield {
          type: 'usage',
          usage: {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            ...(chunk.usage.cost !== undefined ? { cost: chunk.usage.cost } : {}),
          },
        };
      }
    }

    for (const call of accumulator.drain()) yield { type: 'tool_call', call };
    yield { type: 'done', finishReason };
  }
}
