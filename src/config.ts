import fs from 'node:fs';
import path from 'node:path';
import { SnitchError } from './util/errors.js';

export const DEFAULT_MODEL = 'poolside/laguna-s-2.1:free';
/** Default when using the user's own Claude subscription (per Anthropic guidance). */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/**
 * Which LLM backend to talk to. `anthropic` uses the official SDK, which
 * resolves the user's Claude credentials itself (ANTHROPIC_API_KEY, or
 * ANTHROPIC_AUTH_TOKEN, or an `ant auth login` / Claude Code OAuth profile) —
 * so a subscriber needs no API key. `openrouter` uses the raw-fetch provider.
 */
export type ProviderName = 'anthropic' | 'openrouter';

export interface SnitchConfig {
  provider: ProviderName;
  apiKey: string | undefined;
  model: string;
  baseUrl: string;
  /** Approximate prompt-token budget enforced by history trimming. */
  tokenBudget: number;
  /** Agent-loop iteration cap per user turn. */
  maxIterations: number;
  /** Use the prompt-based tool-calling fallback instead of native tools. */
  promptTools: boolean;
}

interface ConfigFile {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  tokenBudget?: number;
  maxIterations?: number;
}

/** True when the Anthropic SDK would find credentials in the environment. */
function hasAnthropicEnv(): boolean {
  return Boolean(process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN']);
}

function readConfigFile(cwd: string): ConfigFile {
  const file = path.join(cwd, 'snitch.config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ConfigFile;
  } catch (error) {
    throw new SnitchError(`Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadConfig(
  overrides: { provider?: ProviderName; model?: string; cwd?: string; promptTools?: boolean } = {},
): SnitchConfig {
  const cwd = overrides.cwd ?? process.cwd();

  const envFile = path.join(cwd, '.env');
  if (fs.existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      // a malformed .env should not be fatal; the key checks below will complain if needed
    }
  }

  const file = readConfigFile(cwd);
  const requestedModel = overrides.model ?? file.model;
  // Pick the backend: explicit flag/config wins; otherwise infer from the
  // environment (Anthropic creds present, or a claude-* model was requested).
  const provider: ProviderName =
    overrides.provider ??
    file.provider ??
    (hasAnthropicEnv() || requestedModel?.startsWith('claude') ? 'anthropic' : 'openrouter');
  const model = requestedModel ?? (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_MODEL);

  return {
    provider,
    apiKey: process.env['SNITCH_API_KEY'] ?? process.env['OPENROUTER_API_KEY'],
    model,
    baseUrl: file.baseUrl ?? 'https://openrouter.ai/api/v1',
    tokenBudget: file.tokenBudget ?? 200_000,
    maxIterations: file.maxIterations ?? 24,
    promptTools: overrides.promptTools ?? false,
  };
}

export function requireApiKey(config: SnitchConfig): string {
  if (!config.apiKey) {
    throw new SnitchError(
      'No API key found. Set SNITCH_API_KEY or OPENROUTER_API_KEY (environment or .env file) to your OpenRouter key, or use --provider anthropic to use your Claude subscription.',
    );
  }
  return config.apiKey;
}
