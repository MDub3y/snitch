import { describe, expect, it } from 'vitest';
import { createTodoTools } from '../src/tools/todo.js';
import type { ToolContext } from '../src/tools/types.js';

const ctx: ToolContext = { cwd: '.' };
const makeTool = () => createTodoTools()[0]!;

describe('todo_write', () => {
  it('never prompts for approval', () => {
    expect(makeTool().requiresApproval).toBe(false);
  });

  it('stores the list and renders it as a checklist', async () => {
    const tool = makeTool();
    const result = await tool.execute(
      {
        todos: [
          { content: 'read the config', status: 'done' },
          { content: 'edit the loop', status: 'in_progress' },
          { content: 'run the tests', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(result).toBe(
      ['Todo list (1/3 done):', '[x] read the config', '[>] edit the loop', '[ ] run the tests'].join('\n'),
    );
  });

  it('replaces the previous list on every call', async () => {
    const tool = makeTool();
    await tool.execute({ todos: [{ content: 'old plan', status: 'pending' }] }, ctx);
    const result = await tool.execute({ todos: [{ content: 'new plan', status: 'pending' }] }, ctx);
    expect(result).toContain('new plan');
    expect(result).not.toContain('old plan');
    expect(await tool.execute({ todos: [] }, ctx)).toBe('(todo list cleared)');
  });

  it('rejects bad statuses and empty content with tool errors', async () => {
    const tool = makeTool();
    await expect(tool.execute({ todos: [{ content: 'x', status: 'later' as never }] }, ctx)).rejects.toThrow(
      /invalid status "later"/,
    );
    await expect(tool.execute({ todos: [{ content: '  ', status: 'pending' }] }, ctx)).rejects.toThrow(
      /non-empty string/,
    );
  });

  it('keeps state per registry instance, not globally', async () => {
    const first = makeTool();
    const second = makeTool();
    await first.execute({ todos: [{ content: 'mine', status: 'pending' }] }, ctx);
    expect(await second.execute({ todos: [] }, ctx)).toBe('(todo list cleared)');
  });
});
