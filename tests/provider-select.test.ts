import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_MODEL, loadConfig } from '../src/config.js';

/** An empty cwd so no stray .env / snitch.config.json leaks into the result. */
let cwd: string;
const saved = { key: process.env['ANTHROPIC_API_KEY'], token: process.env['ANTHROPIC_AUTH_TOKEN'] };

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-cfg-'));
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['ANTHROPIC_AUTH_TOKEN'];
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  if (saved.key === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = saved.key;
  if (saved.token === undefined) delete process.env['ANTHROPIC_AUTH_TOKEN'];
  else process.env['ANTHROPIC_AUTH_TOKEN'] = saved.token;
});

describe('provider selection', () => {
  it('defaults to openrouter with the free model when nothing points to Anthropic', () => {
    const config = loadConfig({ cwd });
    expect(config.provider).toBe('openrouter');
    expect(config.model).toBe(DEFAULT_MODEL);
  });

  it('an explicit --provider anthropic wins and selects the Claude default model', () => {
    const config = loadConfig({ cwd, provider: 'anthropic' });
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it('auto-selects anthropic when an Anthropic credential is in the environment', () => {
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'sub-token';
    expect(loadConfig({ cwd }).provider).toBe('anthropic');
  });

  it('auto-selects anthropic when a claude-* model is requested', () => {
    const config = loadConfig({ cwd, model: 'claude-sonnet-5-5' });
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-5-5');
  });

  it('keeps a requested model on the openrouter default otherwise', () => {
    const config = loadConfig({ cwd, model: 'some/other-model' });
    expect(config.provider).toBe('openrouter');
    expect(config.model).toBe('some/other-model');
  });
});
