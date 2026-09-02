import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { History } from '../src/agent/history.js';
import { runAgent, type AgentEvent } from '../src/agent/loop.js';
import { extractToolCalls, PromptToolAdapter } from '../src/llm/promptTools.js';
import { createDefaultRegistry } from '../src/tools/registry.js';
import { FakeProvider, textTurn } from './helpers/fakeProvider.js';

const callBlock = (name: string, args: object) =>
  '```tool_call\n' + JSON.stringify({ name, arguments: args }) + '\n```';

describe('extractToolCalls', () => {
  it('parses fenced blocks and strips them from the text', () => {
    const { cleanText, calls } = extractToolCalls(
      `I will read the file.\n${callBlock('read_file', { path: 'a.txt' })}`,
    );
    expect(cleanText).toBe('I will read the file.');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe('read_file');
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ path: 'a.txt' });
  });

  it('leaves unparseable blocks in the text and returns no call for them', () => {
    const { cleanText, calls } = extractToolCalls('```tool_call\n{broken json\n```');
    expect(calls).toHaveLength(0);
    expect(cleanText).toContain('{broken json');
  });

  it('handles plain text with no blocks', () => {
    const { cleanText, calls } = extractToolCalls('just an answer');
    expect(cleanText).toBe('just an answer');
    expect(calls).toHaveLength(0);
  });
});

describe('PromptToolAdapter', () => {
  it('injects tool docs into the system prompt and never sends role:tool', async () => {
    const inner = new FakeProvider([textTurn('ok')]);
    const adapter = new PromptToolAdapter(inner);
    const events = [];
    for await (const event of adapter.chat({
      messages: [
        { role: 'system', content: 'base prompt' },
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'some files' },
      ],
      tools: [{ type: 'function', function: { name: 'glob', description: 'find files', parameters: {} } }],
    })) {
      events.push(event);
    }

    const sent = inner.seenMessages[0]!;
    expect(sent[0]!.content).toContain('base prompt');
    expect(sent[0]!.content).toContain('tool_call');
    expect(sent[0]!.content).toContain('glob: find files');
    expect(sent.every((m) => m.role !== 'tool')).toBe(true);
    expect(sent.find((m) => m.role === 'assistant')?.content).toContain('"name": "glob"');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('completes the phase-4 headless scenario: create a script and run it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-pt-'));
    try {
      const inner = new FakeProvider([
        textTurn(`Creating the script.\n${callBlock('write_file', { path: 'hello.js', content: 'console.log("hi from script")' })}`),
        textTurn(`Now running it.\n${callBlock('run_command', { command: 'node hello.js' })}`),
        textTurn('Done: the script printed "hi from script".'),
      ]);
      const events: AgentEvent[] = [];
      const generator = runAgent('create hello.js and run it', {
        provider: new PromptToolAdapter(inner),
        registry: createDefaultRegistry(),
        history: new History('system'),
        cwd: dir,
      });
      for await (const event of generator) {
        events.push(event);
        if (event.type === 'approval_required') event.respond(true);
      }

      expect(fs.readFileSync(path.join(dir, 'hello.js'), 'utf8')).toContain('hi from script');
      const results = events.filter((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>[];
      expect(results).toHaveLength(2);
      expect(results[1]!.result).toContain('hi from script');
      expect(events.at(-1)).toEqual({ type: 'done', reason: 'completed' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
