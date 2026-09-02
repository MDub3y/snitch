import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';

let dir: string;
let ctx: ToolContext;
const registry = createDefaultRegistry();
const run = (args: unknown, context = ctx) => registry.execute('run_command', args, context);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-shell-'));
  ctx = { cwd: dir };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('run_command', () => {
  it('captures output and a zero exit code', async () => {
    const result = await run({ command: 'node -e "console.log(\'hi from shell\')"' });
    expect(result).toContain('exit code: 0');
    expect(result).toContain('hi from shell');
  });

  it('reports non-zero exit codes and stderr', async () => {
    const result = await run({ command: 'node -e "console.error(\'boom\'); process.exit(3)"' });
    expect(result).toContain('exit code: 3');
    expect(result).toContain('boom');
  });

  it('runs in the requested cwd', async () => {
    fs.mkdirSync(path.join(dir, 'inner'));
    const result = await run({ command: 'node -e "console.log(process.cwd())"', cwd: 'inner' });
    expect(result).toContain('inner');
  });

  it('kills the process tree on timeout', async () => {
    const started = Date.now();
    const result = await run({ command: 'node -e "setTimeout(() => {}, 30000)"', timeout_ms: 500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toContain('timed out after 500ms');
  }, 15_000);

  it('is cancellable via AbortSignal', async () => {
    const controller = new AbortController();
    const pending = run(
      { command: 'node -e "setTimeout(() => {}, 30000)"' },
      { cwd: dir, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result).toContain('cancelled by the user');
  }, 15_000);

  it('truncates very large output', async () => {
    const result = await run({ command: 'node -e "process.stdout.write(\'x\'.repeat(100000))"' });
    expect(result).toContain('output truncated at 30000 bytes');
  });
});
