import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { History } from '../src/agent/history.js';
import { runAgent, type AgentEvent } from '../src/agent/loop.js';
import { createTaskTool } from '../src/agent/taskTool.js';
import { createDefaultRegistry } from '../src/tools/registry.js';
import { FakeProvider, textTurn, toolTurn } from './helpers/fakeProvider.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-task-'));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('task tool', () => {
  it('is approval-gated and absent from the default registry', () => {
    const tool = createTaskTool({ getProvider: () => new FakeProvider([]) });
    expect(tool.requiresApproval).toBe(true);
    expect(createDefaultRegistry().get('task')).toBeUndefined(); // sub-agents cannot recurse
  });

  it('runs a fresh sub-agent to completion, auto-approving its tools', async () => {
    // One scripted provider serves both loops in call order:
    // parent turn 1 -> sub turn 1 -> sub turn 2 -> parent turn 2.
    const provider = new FakeProvider([
      toolTurn([
        {
          id: 'call_1',
          name: 'task',
          args: JSON.stringify({ description: 'write a file', prompt: 'create out.txt saying hi' }),
        },
      ]),
      toolTurn([{ id: 'sub_1', name: 'write_file', args: JSON.stringify({ path: 'out.txt', content: 'from sub' }) }]),
      textTurn('sub done: wrote out.txt'),
      textTurn('parent done'),
    ]);

    const registry = createDefaultRegistry();
    registry.register(createTaskTool({ getProvider: () => provider }));

    const events: AgentEvent[] = [];
    const generator = runAgent('delegate this', {
      provider,
      registry,
      history: new History('system'),
      cwd: dir,
    });
    for await (const event of generator) {
      events.push(event);
      if (event.type === 'approval_required') event.respond(true);
    }

    // Only the spawn itself asked for approval; the sub-agent's write_file did not.
    const approvals = events.filter((e) => e.type === 'approval_required');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.call.name).toBe('task');

    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('from sub');
    const taskResult = events.find((e) => e.type === 'tool_result' && e.name === 'task');
    expect(taskResult && taskResult.type === 'tool_result' && taskResult.result).toBe('sub done: wrote out.txt');
    expect(events.at(-2)).toEqual({ type: 'assistant_message', content: 'parent done' });
  });

  it('reports a sub-agent failure as the tool result instead of throwing', async () => {
    const provider = new FakeProvider([]); // sub-agent's first chat() throws: out of turns
    const tool = createTaskTool({ getProvider: () => provider });
    const result = await tool.execute({ description: 'doomed', prompt: 'anything' }, { cwd: dir });
    expect(result).toMatch(/^Sub-agent failed:/);
  });
});
