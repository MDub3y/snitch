import fs from 'node:fs';
import path from 'node:path';
import { SnitchError } from './util/errors.js';

export const DEFAULT_MODEL = 'poolside/laguna-s-2.1:free';

export interface SnitchConfig {
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
  model?: string;
  baseUrl?: string;
  tokenBudget?: number;
  maxIterations?: number;
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

export function loadConfig(overrides: { model?: string; cwd?: string; promptTools?: boolean } = {}): SnitchConfig {
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
  return {
    apiKey: process.env['SNITCH_API_KEY'] ?? process.env['OPENROUTER_API_KEY'],
    model: overrides.model ?? file.model ?? DEFAULT_MODEL,
    baseUrl: file.baseUrl ?? 'https://openrouter.ai/api/v1',
    tokenBudget: file.tokenBudget ?? 200_000,
    maxIterations: file.maxIterations ?? 24,
    promptTools: overrides.promptTools ?? false,
  };
}

export function requireApiKey(config: SnitchConfig): string {
  if (!config.apiKey) {
    throw new SnitchError(
      'No API key found. Set SNITCH_API_KEY or OPENROUTER_API_KEY (environment or .env file) to your OpenRouter key.',
    );
  }
  return config.apiKey;
}
