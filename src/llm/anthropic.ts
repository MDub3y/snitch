import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent, ToolSpec, WireToolCall } from './types.js';

/**
 * Anthropic provider — lets a user drive Snitch with their own Claude
 * subscription instead of an API key. A zero-arg `new Anthropic()` resolves
 * credentials in this order: ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN,
 * then an `ant auth login` / Claude Code OAuth profile on disk — so a user who
 * is signed in to Claude needs no key at all.
 *
 * Snitch owns its own agent loop (runAgent), so this adapter does NOT use the
 * SDK's tool runner (a competing loop). It runs one streamed Messages request
 * per turn and translates to/from our OpenAI-shaped wire types, exactly like
 * the OpenRouter provider, so the loop, tools and UI are unchanged.
 */

/** The slice of the SDK client we use — narrowed so tests can inject a fake. */
export interface AnthropicLike {
  messages: {
    stream(params: Anthropic.MessageStreamParams): AnthropicStream;
  };
}

export interface AnthropicStream extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/** Concatenate all system-role turns into Anthropic's top-level `system`. */
export function toAnthropicSystem(messages: readonly ChatMessage[]): string | undefined {
  const parts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Translate our OpenAI-shaped history into Anthropic message params. Tool calls
 * become `tool_use` blocks on the assistant turn; tool results become
 * `tool_result` blocks in a user turn, with consecutive results merged into one
 * user message (the API requires results to follow their assistant turn).
 */
export function toAnthropicMessages(messages: readonly ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  const pushToolResult = (block: Anthropic.ToolResultBlockParam): void => {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        break; // handled by toAnthropicSystem
      case 'user':
        out.push({ role: 'user', content: message.content });
        break;
      case 'tool':
        pushToolResult({ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content });
        break;
      case 'assistant': {
        const content: Anthropic.ContentBlockParam[] = [];
        if (message.content) content.push({ type: 'text', text: message.content });
        for (const call of message.tool_calls ?? []) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseArguments(call.function.arguments),
          });
        }
        // An assistant turn must carry content; skip an empty one defensively.
        if (content.length > 0) out.push({ role: 'assistant', content });
        break;
      }
    }
  }
  return out;
}

function parseArguments(raw: string): unknown {
  const text = raw.trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Translate our tool specs to Anthropic's tool shape (JSON-Schema `input_schema`). */
export function toAnthropicTools(specs: readonly ToolSpec[] | undefined): Anthropic.Tool[] | undefined {
  if (!specs || specs.length === 0) return undefined;
  return specs.map((spec) => ({
    name: spec.function.name,
    description: spec.function.description,
    input_schema: spec.function.parameters as Anthropic.Tool.InputSchema,
  }));
}

/** Anthropic stop reasons → the finish reasons our loop understands. */
export function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'stop';
  }
}

export interface AnthropicProviderOptions {
  model: string;
  maxTokens?: number;
  /** Inject a client (tests); defaults to a real `new Anthropic()`. */
  client?: AnthropicLike;
  apiKey?: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly model: string;
  readonly capabilities = { nativeTools: true, streaming: true };
  private readonly client: AnthropicLike;
  private readonly maxTokens: number;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 16_000;
    // Zero-arg client resolves API key / auth token / OAuth profile itself.
    this.client = options.client ?? (new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {}) as AnthropicLike);
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamEvent> {
    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: toAnthropicMessages(options.messages),
    };
    const system = toAnthropicSystem(options.messages);
    if (system) params.system = system;
    const tools = toAnthropicTools(options.tools);
    if (tools) params.tools = tools;

    const stream = this.client.messages.stream(params);
    if (options.signal) options.signal.addEventListener('abort', () => void (stream as { abort?: () => void }).abort?.());

    // Stream text live; tool calls and usage come from the assembled message.
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', delta: event.delta.text };
      }
    }

    const message = await stream.finalMessage();
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        const call: WireToolCall = {
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        };
        yield { type: 'tool_call', call };
      }
    }

    const usage = message.usage;
    yield {
      type: 'usage',
      usage: {
        promptTokens:
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
        completionTokens: usage.output_tokens ?? 0,
      },
    };
    yield { type: 'done', finishReason: mapStopReason(message.stop_reason) };
  }
}
