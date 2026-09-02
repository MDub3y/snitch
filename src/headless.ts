import { OpenRouterProvider } from './llm/openrouter.js';
import type { SnitchConfig } from './config.js';
import { requireApiKey } from './config.js';

/**
 * Phase 2 headless runner: one prompt in, streamed reply out.
 * Phase 4 upgrades this to drive the full agent loop with y/n approvals.
 */
export async function runHeadless(prompt: string, config: SnitchConfig): Promise<void> {
  const provider = new OpenRouterProvider({
    apiKey: requireApiKey(config),
    model: config.model,
    baseUrl: config.baseUrl,
  });

  const stream = provider.chat({
    messages: [{ role: 'user', content: prompt }],
    onRetry: ({ status, delayMs, attempt, maxAttempts }) =>
      process.stderr.write(`[snitch] ${status} from OpenRouter, retry ${attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s...\n`),
  });

  for await (const event of stream) {
    if (event.type === 'text') process.stdout.write(event.delta);
    if (event.type === 'usage') {
      process.stderr.write(
        `\n[snitch] tokens: ${event.usage.promptTokens} in / ${event.usage.completionTokens} out` +
          (event.usage.cost !== undefined ? ` ($${event.usage.cost.toFixed(6)})` : '') +
          '\n',
      );
    }
  }
  process.stdout.write('\n');
}
