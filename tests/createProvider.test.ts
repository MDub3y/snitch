import { describe, expect, it } from 'vitest';
import type { SnitchConfig } from '../src/config.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { createProvider } from '../src/llm/createProvider.js';
import { OpenRouterProvider } from '../src/llm/openrouter.js';
import { PromptToolAdapter } from '../src/llm/promptTools.js';

function config(auth: SnitchConfig['auth'], overrides: Partial<SnitchConfig> = {}): SnitchConfig {
  return {
    auth,
    model: 'some/model',
    baseUrl: 'https://openrouter.ai/api/v1',
    tokenBudget: 200_000,
    maxIterations: 24,
    promptTools: false,
    warnings: [],
    ...overrides,
  };
}

describe('createProvider', () => {
  it('openrouter auth yields the OpenAI-compat provider as-is', () => {
    const provider = createProvider(config({ kind: 'openrouter', apiKey: 'k-12345678' }));
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it('openai auth also yields the OpenAI-compat provider (openai flavor, api.openai.com)', () => {
    const provider = createProvider(config({ kind: 'openai', apiKey: 'k-12345678' }));
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it('anthropic auth yields the Messages API provider', () => {
    const provider = createProvider(config({ kind: 'anthropic', apiKey: 'k-12345678' }));
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('subscription auth is always wrapped in PromptToolAdapter (no native tool API)', () => {
    const provider = createProvider(config({ kind: 'subscription', token: 't-12345678' }));
    expect(provider).toBeInstanceOf(PromptToolAdapter);
  });

  it('--prompt-tools wraps any provider', () => {
    const provider = createProvider(config({ kind: 'openrouter', apiKey: 'k-12345678' }, { promptTools: true }));
    expect(provider).toBeInstanceOf(PromptToolAdapter);
  });

  it('a model override beats the configured model', () => {
    const provider = createProvider(config({ kind: 'openrouter', apiKey: 'k-12345678' }), { model: 'other/model' });
    expect(provider.model).toBe('other/model');
  });

  it('throws the no-credentials error for kind none', () => {
    expect(() => createProvider(config({ kind: 'none' }))).toThrow(/No credentials found/);
  });
});
