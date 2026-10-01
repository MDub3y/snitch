import { ApiError, SnitchError } from '../util/errors.js';
import { parseSSE } from './openrouter.js';
import { fetchWithRetry } from './retry.js';
import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent, ToolSpec } from './types.js';

/** Anthropic Messages API wire types (the subset Snitch uses). */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/**
 * Converts the internal OpenAI-shaped history into the Messages API format:
 * system becomes a top-level param, tool_calls become tool_use blocks,
 * tool-role results become tool_result blocks, and consecutive same-role
 * messages merge (the API requires alternating user/assistant turns).
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  let system = '';
  const out: AnthropicMessage[] = [];

  const append = (role: 'user' | 'assistant', blocks: ContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        system = system ? `${system}\n\n${message.content}` : message.content;
        break;
      case 'user':
        append('user', [{ type: 'text', text: message.content }]);
        break;
      case 'assistant': {
        const blocks: ContentBlock[] = [];
        if (message.content) blocks.push({ type: 'text', text: message.content });
        for (const call of message.tool_calls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(call.function.arguments || '{}');
          } catch {
            // malformed args already surfaced to the model as a tool error; send {} rather than fail the request
          }
          blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
        }
        append('assistant', blocks);
        break;
      }
      case 'tool':
        append('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]);
        break;
    }
  }
  return { system, messages: out };
}

function toAnthropicTools(tools: ToolSpec[]): { name: string; description: string; input_schema: unknown }[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/** Streamed Messages API events (the fields Snitch reads). */
interface AnthropicStreamEvent {
  type: string;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

/** Exported for direct testing against SSE fixtures. */
export async function* parseAnthropicChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  let promptTokens = 0;
  let completionTokens = 0;
  let stopReason = 'end_turn';
  let toolCounter = 0;
  let pendingTool: { id: string; name: string; json: string } | null = null;

  for await (const payload of parseSSE(body)) {
    let event: AnthropicStreamEvent;
    try {
      event = JSON.parse(payload) as AnthropicStreamEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case 'error':
        throw new ApiError(0, `Anthropic mid-stream error: ${event.error?.message ?? 'unknown'}`);
      case 'message_start':
        promptTokens = event.message?.usage?.input_tokens ?? 0;
        break;
      case 'content_block_start':
        if (event.content_block?.type === 'tool_use') {
          pendingTool = {
            id: event.content_block.id ?? `acall_${++toolCounter}`,
            name: event.content_block.name ?? '',
            json: '',
          };
        }
        break;
      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          yield { type: 'text', delta: event.delta.text };
        } else if (event.delta?.type === 'input_json_delta' && pendingTool) {
          pendingTool.json += event.delta.partial_json ?? '';
        }
        break;
      case 'content_block_stop':
        if (pendingTool) {
          yield {
            type: 'tool_call',
            call: {
              id: pendingTool.id,
              type: 'function',
              function: { name: pendingTool.name, arguments: pendingTool.json || '{}' },
            },
          };
          pendingTool = null;
        }
        break;
      case 'message_delta':
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        if (event.usage?.output_tokens !== undefined) completionTokens = event.usage.output_tokens;
        break;
    }
  }

  yield { type: 'usage', usage: { promptTokens, completionTokens } };
  const finishReason = stopReason === 'tool_use' ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : 'stop';
  yield { type: 'done', finishReason };
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
}

export class AnthropicProvider implements LLMProvider {
  readonly model: string;
  readonly capabilities = { nativeTools: true, streaming: true };
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com/v1';
    this.maxTokens = options.maxTokens ?? 8192;
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamEvent> {
    const { system, messages } = toAnthropicMessages(options.messages);
    const response = await fetchWithRetry(
      () =>
        fetch(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: this.maxTokens,
            ...(system ? { system } : {}),
            messages,
            ...(options.tools?.length ? { tools: toAnthropicTools(options.tools) } : {}),
            stream: true,
          }),
          signal: options.signal,
        }),
      { signal: options.signal, onRetry: options.onRetry },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new ApiError(401, 'Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.');
      }
      throw new ApiError(response.status, `Anthropic error ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    if (!response.body) throw new SnitchError('Anthropic returned an empty response body.');

    yield* parseAnthropicChunks(response.body);
  }
}
