import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { History } from '../src/agent/history.js';
import { DENIED_RESULT, runAgent, type AgentEvent, type AgentOptions } from '../src/agent/loop.js';
import { createDefaultRegistry } from '../src/tools/registry.js';
import { FakeProvider, textTurn, toolTurn } from './helpers/fakeProvider.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-loop-'));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function options(provider: FakeProvider, extra: Partial<AgentOptions> = {}): AgentOptions {
  return {
    provider,
    registry: createDefaultRegistry(),
    history: new History('test system prompt'),
    cwd: dir,
    ...extra,
  };
}

/** Runs the loop to completion, answering approval prompts with `approve`. */
async function drive(events: AsyncGenerator<AgentEvent>, approve = true): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (event.type === 'approval_required') event.respond(approve);
  }
  return seen;
}

const type = (events: AgentEvent[], t: AgentEvent['type']) => events.filter((e) => e.type === t);

describe('runAgent', () => {
  it('streams a text-only turn and completes', async () => {
    const provider = new FakeProvider([textTurn('Hello', ' world')]);
    const events = await drive(runAgent('hi', options(provider)));

    expect(type(events, 'text_delta')).toHaveLength(2);
    expect(events.at(-2)).toEqual({ type: 'assistant_message', content: 'Hello world' });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'completed' });
    expect(provider.seenMessages[0]![0]!.role).toBe('system');
  });

  it('executes a tool call and feeds the result back to the model', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'file body');
    const provider = new FakeProvider([
      toolTurn([{ id: 'call_1', name: 'read_file', args: '{"path":"a.txt"}' }]),
      textTurn('The file says: file body'),
    ]);
    const events = await drive(runAgent('what does a.txt say?', options(provider)));

    const results = type(events, 'tool_result');
    expect(results).toHaveLength(1);
    expect((results[0] as Extract<AgentEvent, { type: 'tool_result' }>).result).toContain('file body');

    const secondCallMessages = provider.seenMessages[1]!;
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ tool_call_id: 'call_1' });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'completed' });
  });

  it('requires approval for write_file and executes when approved', async () => {
    const provider = new FakeProvider([
      toolTurn([{ id: 'call_1', name: 'write_file', args: '{"path":"out.txt","content":"written"}' }]),
      textTurn('done'),
    ]);
    const events = await drive(runAgent('write out.txt', options(provider)), true);

    const approvals = type(events, 'approval_required');
    expect(approvals).toHaveLength(1);
    expect((approvals[0] as Extract<AgentEvent, { type: 'approval_required' }>).preview).toContain('out.txt');
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('written');
  });

  it('feeds a denial back to the model without executing', async () => {
    const provider = new FakeProvider([
      toolTurn([{ id: 'call_1', name: 'write_file', args: '{"path":"out.txt","content":"nope"}' }]),
      textTurn('understood'),
    ]);
    const events = await drive(runAgent('write out.txt', options(provider)), false);

    expect(fs.existsSync(path.join(dir, 'out.txt'))).toBe(false);
    const result = type(events, 'tool_result')[0] as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(result.result).toBe(DENIED_RESULT);
    expect(provider.seenMessages[1]!.find((m) => m.role === 'tool')).toMatchObject({ content: DENIED_RESULT });
  });

  it('reports malformed tool arguments to the model and keeps going', async () => {
    const provider = new FakeProvider([
      toolTurn([{ id: 'call_1', name: 'read_file', args: '{not json' }]),
      textTurn('sorry'),
    ]);
    const events = await drive(runAgent('go', options(provider)));

    const result = type(events, 'tool_result')[0] as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(result.result).toMatch(/could not parse tool arguments/);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'completed' });
  });

  it('turns tool failures into result strings, not crashes', async () => {
    const provider = new FakeProvider([
      toolTurn([{ id: 'call_1', name: 'read_file', args: '{"path":"missing.txt"}' }]),
      textTurn('that file is missing'),
    ]);
    const events = await drive(runAgent('read it', options(provider)));
    const result = type(events, 'tool_result')[0] as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(result.result).toMatch(/^Error: File not found/);
  });

  it('stops at max_iterations when the model never finishes', async () => {
    const endless = Array.from({ length: 5 }, (_, i) =>
      toolTurn([{ id: `call_${i}`, name: 'list_dir', args: '{}' }]),
    );
    const provider = new FakeProvider(endless);
    const events = await drive(runAgent('loop forever', options(provider, { maxIterations: 3 })));

    expect(type(events, 'tool_result')).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'max_iterations' });
  });

  it('reports cancellation when the signal aborts mid-run', async () => {
    const controller = new AbortController();
    const provider = new FakeProvider([
      toolTurn([{ id: 'call_1', name: 'list_dir', args: '{}' }]),
      textTurn('never reached'),
    ]);
    const events: AgentEvent[] = [];
    for await (const event of runAgent('go', options(provider, { signal: controller.signal }))) {
      events.push(event);
      if (event.type === 'tool_result') controller.abort();
    }
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'cancelled' });
  });

  it('surfaces provider errors as a done:error event', async () => {
    const provider = new FakeProvider([]); // immediately throws "out of turns"
    const events = await drive(runAgent('go', options(provider)));
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'error' });
  });
});
