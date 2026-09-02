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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-fs-'));
  ctx = { cwd: dir };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('read_file', () => {
  it('returns numbered lines and honours offset/limit', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour');
    expect(await run('read_file', { path: 'a.txt' })).toBe('    1: one\n    2: two\n    3: three\n    4: four');
    expect(await run('read_file', { path: 'a.txt', offset: 2, limit: 2 })).toBe(
      '    2: two\n    3: three\n(1 more lines — use offset to continue)',
    );
  });

  it('reports missing files and binary files as tool errors', async () => {
    expect(await run('read_file', { path: 'nope.txt' })).toMatch(/^Error: File not found/);
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    expect(await run('read_file', { path: 'bin.dat' })).toMatch(/binary/);
  });
});

describe('write_file', () => {
  it('creates parent directories and reports a create/overwrite preview', async () => {
    const result = await run('write_file', { path: 'deep/nested/new.txt', content: 'hello' });
    expect(result).toMatch(/Wrote 5 characters/);
    expect(fs.readFileSync(path.join(dir, 'deep/nested/new.txt'), 'utf8')).toBe('hello');

    const tool = registry.get('write_file')!;
    expect(await tool.preview!({ path: 'deep/nested/new.txt', content: 'x\ny' }, ctx)).toMatch(/overwrite .*1 lines -> 2 lines/);
    expect(await tool.preview!({ path: 'fresh.txt', content: 'x' }, ctx)).toMatch(/create .*fresh\.txt/);
  });
});

describe('edit_file', () => {
  beforeEach(() => fs.writeFileSync(path.join(dir, 'e.txt'), 'aaa bbb aaa'));

  it('errors when old_string is missing or ambiguous', async () => {
    expect(await run('edit_file', { path: 'e.txt', old_string: 'zzz', new_string: 'y' })).toMatch(/not found/);
    expect(await run('edit_file', { path: 'e.txt', old_string: 'aaa', new_string: 'y' })).toMatch(
      /appears 2 times/,
    );
  });

  it('replaces a unique match, or all matches with replace_all', async () => {
    expect(await run('edit_file', { path: 'e.txt', old_string: 'bbb', new_string: 'BBB' })).toMatch(/Replaced 1/);
    expect(fs.readFileSync(path.join(dir, 'e.txt'), 'utf8')).toBe('aaa BBB aaa');
    expect(await run('edit_file', { path: 'e.txt', old_string: 'aaa', new_string: 'A', replace_all: true })).toMatch(
      /Replaced 2/,
    );
    expect(fs.readFileSync(path.join(dir, 'e.txt'), 'utf8')).toBe('A BBB A');
  });
});

describe('list_dir', () => {
  it('lists directories first with file sizes', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'file.txt'), '12345');
    expect(await run('list_dir', {})).toBe('sub/\nfile.txt  (5 bytes)');
    expect(await run('list_dir', { path: 'missing' })).toMatch(/^Error: Directory not found/);
  });
});
