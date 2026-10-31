import type { SnitchConfig } from '../config.js';
import { requireApiKey } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenRouterProvider } from './openrouter.js';
import { PromptToolAdapter } from './promptTools.js';
import type { LLMProvider } from './types.js';

/**
 * Builds the LLM provider for a run from config. `anthropic` lets the user
 * drive Snitch with their own Claude subscription (the SDK resolves their
 * credentials — no API key needed); `openrouter` is the raw-fetch provider.
 * The `--prompt-tools` fallback only applies to OpenRouter models that lack
 * native tool calling — Anthropic always has it, so it's never wrapped.
 */
export function createProvider(config: SnitchConfig): LLMProvider {
  if (config.provider === 'anthropic') {
    return new AnthropicProvider({ model: config.model });
  }
  const openRouter = new OpenRouterProvider({
    apiKey: requireApiKey(config),
    model: config.model,
    baseUrl: config.baseUrl,
  });
  return config.promptTools ? new PromptToolAdapter(openRouter) : openRouter;
}
