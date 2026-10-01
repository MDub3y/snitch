import { SnitchError } from '../util/errors.js';
import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent } from './types.js';

/**
 * Minimal view of the Claude Agent SDK surface Snitch touches. The SDK is an
 * optional dependency (BYOK installs work without it), so these are declared
 * locally instead of imported.
 */
interface SDKAssistantMessage {
  type: 'assistant';
  message?: { content?: { type: string; text?: string }[] };
}
interface SDKResultMessage {
  type: 'result';
  subtype: string;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}
type SDKMessage = SDKAssistantMessage | SDKResultMessage | { type: string };

export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SDKMessage>;

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

async function loadQueryFn(): Promise<QueryFn> {
  try {
    const sdk = (await import(SDK_PACKAGE)) as { query: QueryFn };
    return sdk.query;
  } catch {
    throw new SnitchError(
      `Subscription mode needs the Claude Agent SDK, which is an optional dependency. Install it with: npm install ${SDK_PACKAGE}`,
    );
  }
}

/**
 * The agent loop re-sends the full history each call, but the SDK takes one
 * prompt per query — so the transcript is flattened into a single prompt.
 * Tool-role messages only appear here as a defensive fallback: in practice
 * this provider is always wrapped in PromptToolAdapter, which rewrites them
 * before they arrive.
 */
export function flattenToPrompt(messages: ChatMessage[]): { system: string; prompt: string } {
  let system = '';
  const parts: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        system = system ? `${system}\n\n${message.content}` : message.content;
        break;
      case 'user':
        parts.push(`[user]\n${message.content}`);
        break;
      case 'assistant':
        if (message.content) parts.push(`[assistant]\n${message.content}`);
        break;
      case 'tool':
        parts.push(`[tool result]\n${message.content}`);
        break;
    }
  }
  return { system, prompt: parts.join('\n\n') };
}

export interface SubscriptionProviderOptions {
  model: string;
  /** Injectable for tests; defaults to the Agent SDK's query(). */
  queryFn?: QueryFn;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs on a Claude Pro/Max plan via the Agent SDK's OAuth session — no API
 * key, no per-token billing. Tools are disabled (allowedTools: []) and the
 * final message is read back, so each call behaves like a plain model call,
 * not a nested agent. No native tool API means capabilities.nativeTools is
 * false; createProvider wraps this in PromptToolAdapter.
 */
export class SubscriptionProvider implements LLMProvider {
  readonly model: string;
  readonly capabilities = { nativeTools: false, streaming: true };
  private readonly queryFn: QueryFn | undefined;
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(options: SubscriptionProviderOptions) {
    this.model = options.model;
    this.queryFn = options.queryFn;
    this.baseEnv = options.env ?? process.env;
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamEvent> {
    const query = this.queryFn ?? (await loadQueryFn());
    const { system, prompt } = flattenToPrompt(options.messages);

    // The SDK silently prefers ANTHROPIC_API_KEY over the OAuth token and
    // would bill API credits; scrub it so the subscription path actually runs
    // on the subscription.
    const env: NodeJS.ProcessEnv = { ...this.baseEnv };
    delete env['ANTHROPIC_API_KEY'];

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const stream = query({
        prompt,
        options: {
          model: this.model,
          ...(system ? { systemPrompt: system } : {}),
          allowedTools: [],
          maxTurns: 1,
          env,
          abortController,
        },
      });

      for await (const message of stream) {
        if (options.signal?.aborted) break;
        if (message.type === 'assistant') {
          for (const block of (message as SDKAssistantMessage).message?.content ?? []) {
            if (block.type === 'text' && block.text) yield { type: 'text', delta: block.text };
          }
        } else if (message.type === 'result') {
          const result = message as SDKResultMessage;
          if (result.subtype !== 'success') {
            throw new SnitchError(
              `Claude subscription call failed (${result.subtype})${result.result ? `: ${result.result}` : ''}`,
            );
          }
          yield {
            type: 'usage',
            usage: {
              promptTokens: result.usage?.input_tokens ?? 0,
              completionTokens: result.usage?.output_tokens ?? 0,
              ...(typeof result.total_cost_usd === 'number' ? { cost: result.total_cost_usd } : {}),
            },
          };
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }

    yield { type: 'done', finishReason: 'stop' };
  }
}
