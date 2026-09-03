import { describe, expect, it } from 'vitest';
import { compactHistory } from '../src/agent/compact.js';
import { History } from '../src/agent/history.js';
import { FakeProvider, textTurn } from './helpers/fakeProvider.js';

function longHistory(): History {
  const history = new History('system prompt');
  for (let i = 0; i < 10; i++) {
    history.addUser(`task ${i}`);
    history.addAssistant(`reply ${i}`);
  }
  return history;
}

describe('History compaction', () => {
  it('estimate grows with content', () => {
    const history = new History('sys');
    const before = history.estimate();
    history.addUser('x'.repeat(4000));
    expect(history.estimate()).toBeGreaterThan(before + 900);
  });

  it('compact keeps the recent tail and replaces the rest with the summary', () => {
    const history = longHistory();
    history.compact('the summary text', 4);
    const messages = history.toMessages();
    expect(messages[1]).toEqual({ role: 'user', content: '[Summary of the earlier conversation]\nthe summary text' });
    expect(messages).toHaveLength(1 + 1 + 4); // system + summary + tail
    expect(JSON.stringify(messages)).toContain('reply 9');
    expect(JSON.stringify(messages)).not.toContain('task 0');
  });

  it('compact never leaves the tail starting on an orphaned tool result', () => {
    const history = new History('sys');
    history.addUser('go');
    history.addAssistant(null, [{ id: 'c1', type: 'function', function: { name: 'glob', arguments: '{}' } }]);
    history.addToolResult('c1', 'files');
    history.addUser('next');
    history.addAssistant('done');
    history.compact('summary', 3); // tail would start at the tool result
    const roles = history.toMessages().map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'user', 'assistant']);
  });

  it('compactHistory summarizes via the provider and rewrites history', async () => {
    const history = longHistory();
    const provider = new FakeProvider([textTurn('dense summary of the work')]);
    const summary = await compactHistory(provider, history);
    expect(summary).toBe('dense summary of the work');
    expect(JSON.stringify(history.toMessages())).toContain('dense summary of the work');
    // the summarizer saw the old transcript
    expect(JSON.stringify(provider.seenMessages[0])).toContain('task 0');
  });

  it('compactHistory is a no-op on a short conversation', async () => {
    const history = new History('sys');
    history.addUser('only message');
    const provider = new FakeProvider([]);
    expect(await compactHistory(provider, history)).toBe('');
    expect(provider.seenMessages).toHaveLength(0);
  });
});
