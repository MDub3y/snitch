import { requireAuth, type SnitchConfig } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenRouterProvider } from './openrouter.js';
import { PromptToolAdapter } from './promptTools.js';
import { SubscriptionProvider } from './subscription.js';
import type { LLMProvider } from './types.js';

/**
 * The one place auth kind maps to a provider. Providers without native tool
 * calling (the subscription path) are wrapped in PromptToolAdapter so the
 * agent loop sees the same contract everywhere.
 */
export function createProvider(config: SnitchConfig, overrides: { model?: string } = {}): LLMProvider {
  const auth = requireAuth(config);
  const model = overrides.model ?? config.model;

  let provider: LLMProvider;
  switch (auth.kind) {
    case 'subscription':
      provider = new SubscriptionProvider({ model });
      break;
    case 'anthropic':
      provider = new AnthropicProvider({ apiKey: auth.apiKey, model });
      break;
    case 'openai':
      provider = new OpenRouterProvider({ apiKey: auth.apiKey, model, baseUrl: 'https://api.openai.com/v1', flavor: 'openai' });
      break;
    case 'openrouter':
      provider = new OpenRouterProvider({ apiKey: auth.apiKey, model, baseUrl: config.baseUrl });
      break;
  }

  if (config.promptTools || !provider.capabilities.nativeTools) return new PromptToolAdapter(provider);
  return provider;
}
