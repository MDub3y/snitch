import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';

let dir: string;
let ctx: ToolContext;
const registry = createDefaultRegistry();
const run = (tool: string, args: unknown) => registry.execute(tool, args, ctx);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-search-'));
  ctx = { cwd: dir };
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), 'export const needle = 42;\nconst other = 1;');
  fs.writeFileSync(path.join(dir, 'src', 'util.ts'), 'export function helper() {}\n// needle here too');
  fs.writeFileSync(path.join(dir, 'readme.md'), '# hi');
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.ts'), 'const needle = 0;');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('glob', () => {
  it('matches patterns and ignores node_modules', async () => {
    const result = await run('glob', { pattern: '**/*.ts' });
    expect(result).toContain('main.ts');
    expect(result).toContain('util.ts');
    expect(result).not.toContain('node_modules');
  });

  it('reports when nothing matches', async () => {
    expect(await run('glob', { pattern: '**/*.rs' })).toBe('No files match **/*.rs');
  });
});

describe('grep', () => {
  it('returns file:line matches relative to the search root', async () => {
    const result = await run('grep', { pattern: 'needle', glob: '**/*.ts' });
    expect(result).toContain('main.ts:1:');
    expect(result).toContain('util.ts:2:');
    expect(result).not.toContain('node_modules');
  });

  it('respects max_results and reports invalid regexes', async () => {
    const result = await run('grep', { pattern: 'e', max_results: 1 });
    expect(result).toMatch(/stopped at 1 results/);
    expect(await run('grep', { pattern: '(' })).toMatch(/^Error: Invalid regex/);
  });

  it('skips binary files', async () => {
    fs.writeFileSync(path.join(dir, 'bin.ts'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
    const result = await run('grep', { pattern: 'needle', glob: 'bin.ts' });
    expect(result).toMatch(/No matches/);
  });
});
