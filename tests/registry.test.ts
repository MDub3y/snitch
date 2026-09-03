import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../src/tools/registry.js';

describe('ToolRegistry', () => {
  const registry = createDefaultRegistry();

  it('registers the 9 default tools with the right approval gates', () => {
    expect(registry.names()).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'list_dir',
      'glob',
      'grep',
      'run_command',
      'todo_write',
      'fetch_url',
    ]);
    const needsApproval = registry.names().filter((name) => registry.get(name)!.requiresApproval);
    expect(needsApproval).toEqual(['write_file', 'edit_file', 'run_command']);
  });

  it('serializes to the OpenAI tools wire format', () => {
    expect(registry.toSpecs()).toMatchSnapshot();
  });

  it('reports unknown tools as a result string, not a throw', async () => {
    expect(await registry.execute('nope', {}, { cwd: '.' })).toMatch(/^Error: unknown tool "nope"/);
  });
});
