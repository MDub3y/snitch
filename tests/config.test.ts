import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, loadConfig, requireApiKey } from '../src/config.js';

let dir: string;
const savedEnv = { snitch: process.env['SNITCH_API_KEY'], openrouter: process.env['OPENROUTER_API_KEY'] };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-config-'));
  delete process.env['SNITCH_API_KEY'];
  delete process.env['OPENROUTER_API_KEY'];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv.snitch !== undefined) process.env['SNITCH_API_KEY'] = savedEnv.snitch;
  if (savedEnv.openrouter !== undefined) process.env['OPENROUTER_API_KEY'] = savedEnv.openrouter;
});

describe('loadConfig', () => {
  it('uses defaults when nothing is configured', () => {
    const config = loadConfig({ cwd: dir });
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(config.apiKey).toBeUndefined();
    expect(config.tokenBudget).toBe(200_000);
    expect(config.maxIterations).toBe(24);
  });

  it('prefers CLI model over config file over default', () => {
    fs.writeFileSync(path.join(dir, 'snitch.config.json'), JSON.stringify({ model: 'file/model' }));
    expect(loadConfig({ cwd: dir }).model).toBe('file/model');
    expect(loadConfig({ cwd: dir, model: 'cli/model' }).model).toBe('cli/model');
  });

  it('reads the API key from a .env file, preferring SNITCH_API_KEY', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=or-key\nSNITCH_API_KEY=snitch-key\n');
    expect(loadConfig({ cwd: dir }).apiKey).toBe('snitch-key');
  });
});

describe('requireApiKey', () => {
  it('throws a clear message when no key is set', () => {
    expect(() => requireApiKey(loadConfig({ cwd: dir }))).toThrow(/SNITCH_API_KEY or OPENROUTER_API_KEY/);
  });
});
