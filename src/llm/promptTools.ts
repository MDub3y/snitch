import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent, ToolSpec, WireToolCall } from './types.js';

const CALL_FENCE = /```tool_call\s*\n([\s\S]*?)```/g;
// Some models ignore the fenced-JSON instruction and emit their trained
// tool-call markup instead (observed live with poolside/laguna-s-2.1):
// <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>...</tool_call>
const CALL_XML = /<tool_call>\s*([\w./:-]+)([\s\S]*?)<\/tool_call>/g;
const XML_ARG = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;

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

/**
 * Lenient extraction: fenced tool_call blocks (our documented format) and
 * XML-style <tool_call> markup (what some models emit anyway) both become
 * WireToolCalls.
 */
export function extractToolCalls(text: string): { cleanText: string; calls: WireToolCall[] } {
  const calls: WireToolCall[] = [];
  let counter = 0;
  const push = (name: string, args: string) =>
    calls.push({
      id: `pcall_${++counter}_${Date.now()}`,
      type: 'function',
      function: { name, arguments: args },
    });

  const cleanText = text
    .replace(CALL_FENCE, (whole, body: string) => {
      try {
        const parsed = JSON.parse(body.trim()) as { name?: unknown; arguments?: unknown };
        if (typeof parsed.name !== 'string') return whole;
        push(parsed.name, JSON.stringify(parsed.arguments ?? {}));
        return '';
      } catch {
        return whole; // leave unparseable blocks visible in the text
      }
    })
    .replace(CALL_XML, (_whole, name: string, argsBody: string) => {
      const args: Record<string, unknown> = {};
      for (const [, key, value] of argsBody.matchAll(XML_ARG)) {
        // Coerce only unambiguous scalars; anything else stays a verbatim string
        // so file content that happens to look like JSON is never mangled.
        const scalar = /^(true|false|null|-?\d+(\.\d+)?)$/.test(value!.trim());
        args[key!.trim()] = scalar ? JSON.parse(value!.trim()) : value!;
      }
      push(name, JSON.stringify(args));
      return '';
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
