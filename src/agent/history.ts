import type { ChatMessage, WireToolCall } from '../llm/types.js';
import { estimateTokens } from '../util/tokens.js';

const TRIM_MARKER: ChatMessage = {
  role: 'system',
  content: '[Earlier conversation was trimmed to fit the context budget.]',
};

export class History {
  private readonly messages: ChatMessage[] = [];

  constructor(private readonly systemPrompt: string) {}

  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  addAssistant(content: string | null, toolCalls?: WireToolCall[]): void {
    this.messages.push({
      role: 'assistant',
      content,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    });
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: 'tool', tool_call_id: toolCallId, content });
  }

  clear(): void {
    this.messages.length = 0;
  }

  /**
   * Returns system prompt + messages, dropping the oldest messages when the
   * naive token estimate exceeds `tokenBudget`. Never drops the system prompt
   * or the latest user message, and never leaves a tool result without the
   * assistant tool_call it answers (or vice versa).
   */
  toMessages(tokenBudget = Infinity): ChatMessage[] {
    const system: ChatMessage = { role: 'system', content: this.systemPrompt };
    let kept = [...this.messages];

    const lastUserAt = kept.findLastIndex((m) => m.role === 'user');
    const cost = (msgs: ChatMessage[]) => estimateTokens(JSON.stringify([system, ...msgs]));

    let trimmed = false;
    while (kept.length > 0 && cost(kept) > tokenBudget) {
      const protectedFrom = kept.findLastIndex((m) => m.role === 'user');
      if (protectedFrom <= 0 && lastUserAt !== -1) break; // only the final exchange remains
      let dropCount = 1;
      const first = kept[0]!;
      if (first.role === 'assistant' && first.tool_calls?.length) {
        while (dropCount < kept.length && kept[dropCount]!.role === 'tool') dropCount++;
      }
      kept = kept.slice(dropCount);
      trimmed = true;
    }
    // never start on an orphaned tool result
    while (kept[0]?.role === 'tool') {
      kept = kept.slice(1);
      trimmed = true;
    }

    return trimmed ? [system, TRIM_MARKER, ...kept] : [system, ...kept];
  }
}
