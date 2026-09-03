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

  /** Naive token estimate (chars/4) of the whole serialized conversation. */
  estimate(): number {
    return estimateTokens(JSON.stringify([{ role: 'system', content: this.systemPrompt }, ...this.messages]));
  }

  /** Plain-text rendering of everything older than the last `keepRecent` messages, for the summarizer. */
  transcript(keepRecent: number): string {
    const older = this.messages.slice(0, Math.max(0, this.messages.length - keepRecent));
    return older
      .map((message) => {
        if (message.role === 'assistant') {
          const calls = message.tool_calls
            ?.map((call) => `${call.function.name}(${call.function.arguments.slice(0, 200)})`)
            .join(', ');
          return `assistant: ${message.content ?? ''}${calls ? `\n[called: ${calls}]` : ''}`;
        }
        if (message.role === 'tool') return `tool result: ${message.content.slice(0, 500)}`;
        return `${message.role}: ${message.content}`;
      })
      .join('\n');
  }

  /**
   * Replaces everything except the last `keepRecent` messages with a summary
   * note. The kept tail never starts on an orphaned tool result.
   */
  compact(summary: string, keepRecent: number): void {
    if (this.messages.length <= keepRecent) return;
    let tail = this.messages.slice(-keepRecent);
    while (tail[0]?.role === 'tool') tail = tail.slice(1);
    const note: ChatMessage = { role: 'user', content: `[Summary of the earlier conversation]\n${summary}` };
    this.messages.length = 0;
    this.messages.push(note, ...tail);
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
