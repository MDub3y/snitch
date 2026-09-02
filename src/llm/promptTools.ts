import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent, ToolSpec, WireToolCall } from './types.js';

const CALL_FENCE = /```tool_call\s*\n([\s\S]*?)```/g;

function toolInstructions(tools: ToolSpec[]): string {
  const docs = tools
    .map((t) => `- ${t.function.name}: ${t.function.description}\n  parameters: ${JSON.stringify(t.function.parameters)}`)
    .join('\n');
  return `

You cannot call tools natively. To call a tool, end your reply with one fenced block per call, exactly like:
\`\`\`tool_call
{"name": "<tool name>", "arguments": {<JSON arguments>}}
\`\`\`
After each call you will receive its result in the next user message. When the task is done, reply with plain text and NO tool_call block.

Available tools:
${docs}`;
}

/**
 * Rewrites tool-role messages into plain user/assistant text, since models
 * without native tool calling reject role:"tool" and tool_calls fields.
 */
function flatten(messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
  return messages.map((message, index) => {
    if (message.role === 'system' && index === 0) {
      return { role: 'system' as const, content: message.content + toolInstructions(tools) };
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const blocks = message.tool_calls
        .map((c) => `\`\`\`tool_call\n{"name": ${JSON.stringify(c.function.name)}, "arguments": ${c.function.arguments || '{}'}}\n\`\`\``)
        .join('\n');
      return { role: 'assistant' as const, content: [message.content, blocks].filter(Boolean).join('\n') };
    }
    if (message.role === 'tool') {
      return { role: 'user' as const, content: `[tool result]\n${message.content}` };
    }
    return message;
  });
}

/** Lenient extraction: fenced tool_call blocks parsed into WireToolCalls. */
export function extractToolCalls(text: string): { cleanText: string; calls: WireToolCall[] } {
  const calls: WireToolCall[] = [];
  let counter = 0;
  const cleanText = text
    .replace(CALL_FENCE, (whole, body: string) => {
      try {
        const parsed = JSON.parse(body.trim()) as { name?: unknown; arguments?: unknown };
        if (typeof parsed.name !== 'string') return whole;
        calls.push({
          id: `pcall_${++counter}_${Date.now()}`,
          type: 'function',
          function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments ?? {}) },
        });
        return '';
      } catch {
        return whole; // leave unparseable blocks visible in the text
      }
    })
    .trim();
  return { cleanText, calls };
}

/**
 * Wraps any provider so the agent loop can keep using native-style tool
 * calls: tool docs go into the system prompt, and fenced JSON blocks in the
 * reply come back out as tool_call events. Text is buffered per turn (no
 * live deltas) because the call blocks must be stripped before display.
 */
export class PromptToolAdapter implements LLMProvider {
  readonly capabilities = { nativeTools: true, streaming: false };

  constructor(private readonly inner: LLMProvider) {}

  get model(): string {
    return `${this.inner.model} (prompt-tools)`;
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamEvent> {
    let text = '';
    let finishReason = 'stop';
    const innerStream = this.inner.chat({
      messages: flatten(options.messages, options.tools ?? []),
      // no `tools` — the whole point is the inner model can't take them
      signal: options.signal,
      onRetry: options.onRetry,
    });
    for await (const event of innerStream) {
      if (event.type === 'text') text += event.delta;
      else if (event.type === 'usage') yield event;
      else if (event.type === 'done') finishReason = event.finishReason;
    }

    const { cleanText, calls } = extractToolCalls(text);
    if (cleanText) yield { type: 'text', delta: cleanText };
    for (const call of calls) yield { type: 'tool_call', call };
    yield { type: 'done', finishReason: calls.length > 0 ? 'tool_calls' : finishReason };
  }
}
