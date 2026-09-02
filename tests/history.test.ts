import { describe, expect, it } from 'vitest';
import { History } from '../src/agent/history.js';

function filled(): History {
  const history = new History('system prompt');
  history.addUser('first question');
  history.addAssistant(null, [
    { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
  ]);
  history.addToolResult('call_1', 'x'.repeat(400));
  history.addAssistant('first answer');
  history.addUser('second question');
  history.addAssistant('second answer');
  return history;
}

describe('History.toMessages', () => {
  it('returns system prompt plus all messages when within budget', () => {
    const messages = filled().toMessages();
    expect(messages[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(messages).toHaveLength(7);
  });

  it('trims oldest messages first and inserts a single marker', () => {
    const messages = filled().toMessages(120);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.content).toMatch(/trimmed/);
    const rest = messages.slice(2);
    expect(rest.some((m) => m.role === 'user' && m.content === 'second question')).toBe(true);
    expect(rest.some((m) => m.role === 'user' && m.content === 'first question')).toBe(false);
  });

  it('never drops a tool_call assistant message without its tool results', () => {
    for (const budget of [50, 100, 150, 200, 250, 300]) {
      const messages = filled().toMessages(budget);
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i]!;
        if (message.role === 'tool') {
          const before = messages[i - 1]!;
          const isAnswered =
            (before.role === 'assistant' || before.role === 'tool') &&
            messages.some(
              (m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === message.tool_call_id),
            );
          expect(isAnswered, `orphaned tool result at budget ${budget}`).toBe(true);
        }
      }
    }
  });

  it('always keeps the latest user message even over budget', () => {
    const messages = filled().toMessages(1);
    expect(messages.some((m) => m.role === 'user' && m.content === 'second question')).toBe(true);
  });
});
