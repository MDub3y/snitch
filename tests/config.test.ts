import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, DEFAULT_MODELS, loadConfig, requireAuth } from '../src/config.js';

const AUTH_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'SNITCH_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-config-'));
  for (const name of AUTH_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const name of AUTH_VARS) {
    if (savedEnv[name] !== undefined) process.env[name] = savedEnv[name];
    else delete process.env[name];
  }
});

describe('loadConfig', () => {
  it('uses defaults when nothing is configured', () => {
    const config = loadConfig({ cwd: dir });
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(config.auth.kind).toBe('none');
    expect(config.tokenBudget).toBe(200_000);
    expect(config.maxIterations).toBe(24);
    expect(config.warnings).toEqual([]);
  });

  it('prefers CLI model over config file over default', () => {
    fs.writeFileSync(path.join(dir, 'snitch.config.json'), JSON.stringify({ model: 'file/model' }));
    expect(loadConfig({ cwd: dir }).model).toBe('file/model');
    expect(loadConfig({ cwd: dir, model: 'cli/model' }).model).toBe('cli/model');
  });

  it('reads credentials from a .env file, preferring SNITCH_API_KEY', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=or-key-12345\nSNITCH_API_KEY=snitch-key-12345\n');
    const config = loadConfig({ cwd: dir });
    expect(config.auth).toEqual({ kind: 'openrouter', apiKey: 'snitch-key-12345' });
  });
});

describe('auth resolution matrix', () => {
  it('CLAUDE_CODE_OAUTH_TOKEN selects the subscription path and its default model', () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'oauth-token-12345';
    const config = loadConfig({ cwd: dir });
    expect(config.auth).toEqual({ kind: 'subscription', token: 'oauth-token-12345' });
    expect(config.model).toBe(DEFAULT_MODELS.subscription);
    expect(config.warnings).toEqual([]);
  });

  it('subscription token beats every API key, with a warning when ANTHROPIC_API_KEY is also set', () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'oauth-token-12345';
    process.env['SNITCH_API_KEY'] = 'or-key-12345';
    process.env['ANTHROPIC_API_KEY'] = 'ant-key-12345';
    process.env['OPENAI_API_KEY'] = 'oai-key-12345';
    const config = loadConfig({ cwd: dir });
    expect(config.auth.kind).toBe('subscription');
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('no warning for a subscription token without a conflicting ANTHROPIC_API_KEY', () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'oauth-token-12345';
    process.env['OPENAI_API_KEY'] = 'oai-key-12345';
    expect(loadConfig({ cwd: dir }).warnings).toEqual([]);
  });

  it('OpenRouter key beats direct Anthropic and OpenAI keys', () => {
    process.env['OPENROUTER_API_KEY'] = 'or-key-12345';
    process.env['ANTHROPIC_API_KEY'] = 'ant-key-12345';
    process.env['OPENAI_API_KEY'] = 'oai-key-12345';
    const config = loadConfig({ cwd: dir });
    expect(config.auth).toEqual({ kind: 'openrouter', apiKey: 'or-key-12345' });
    expect(config.model).toBe(DEFAULT_MODELS.openrouter);
  });

  it('ANTHROPIC_API_KEY alone selects the direct Anthropic path', () => {
    process.env['ANTHROPIC_API_KEY'] = 'ant-key-12345';
    const config = loadConfig({ cwd: dir });
    expect(config.auth).toEqual({ kind: 'anthropic', apiKey: 'ant-key-12345' });
    expect(config.model).toBe(DEFAULT_MODELS.anthropic);
  });

  it('OPENAI_API_KEY alone selects the direct OpenAI path', () => {
    process.env['OPENAI_API_KEY'] = 'oai-key-12345';
    const config = loadConfig({ cwd: dir });
    expect(config.auth).toEqual({ kind: 'openai', apiKey: 'oai-key-12345' });
    expect(config.model).toBe(DEFAULT_MODELS.openai);
  });
});

describe('requireAuth', () => {
  it('throws a clear message naming every option when nothing is set', () => {
    const config = loadConfig({ cwd: dir });
    expect(() => requireAuth(config)).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(() => requireAuth(config)).toThrow(/SNITCH_API_KEY/);
    expect(() => requireAuth(config)).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => requireAuth(config)).toThrow(/OPENAI_API_KEY/);
  });

  it('returns the resolved auth when present', () => {
    process.env['SNITCH_API_KEY'] = 'or-key-12345';
    expect(requireAuth(loadConfig({ cwd: dir }))).toEqual({ kind: 'openrouter', apiKey: 'or-key-12345' });
  });
});
