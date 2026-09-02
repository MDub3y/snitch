/** Wire-format types follow the OpenAI chat-completions shape OpenRouter speaks. */

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** USD, when the provider reports it (OpenRouter does). */
  cost?: number;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  /** Emitted once per tool call, after its argument deltas are fully accumulated. */
  | { type: 'tool_call'; call: WireToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: string };

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  status: number;
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  /** Surfaced so UIs can show "rate limited, retrying in Ns". */
  onRetry?: (info: RetryInfo) => void;
}

export interface LLMProvider {
  readonly model: string;
  readonly capabilities: { nativeTools: boolean; streaming: boolean };
  chat(options: ChatOptions): AsyncIterable<StreamEvent>;
}
