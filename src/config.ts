import fs from 'node:fs';
import path from 'node:path';
import { SnitchError } from './util/errors.js';
import { registerSecret } from './util/redact.js';

export const DEFAULT_MODEL = 'poolside/laguna-s-2.1:free';

/** Default model per auth path, used when neither --model nor the config file picks one. */
export const DEFAULT_MODELS = {
  subscription: 'claude-sonnet-4-5',
  openrouter: DEFAULT_MODEL,
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
  none: DEFAULT_MODEL,
} as const;

export type ResolvedAuth =
  | { kind: 'subscription'; token: string }
  | { kind: 'openrouter'; apiKey: string }
  | { kind: 'anthropic'; apiKey: string }
  | { kind: 'openai'; apiKey: string }
  | { kind: 'none' };

export interface SnitchConfig {
  auth: ResolvedAuth;
  model: string;
  /** Base URL for the OpenRouter (OpenAI-compatible) path. */
  baseUrl: string;
  /** Approximate prompt-token budget enforced by history trimming. */
  tokenBudget: number;
  /** Agent-loop iteration cap per user turn. */
  maxIterations: number;
  /** Use the prompt-based tool-calling fallback instead of native tools. */
  promptTools: boolean;
  /** Startup warnings (e.g. conflicting credentials) for the entry point to print. */
  warnings: string[];
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

/**
 * Credential priority: Claude subscription OAuth token, then OpenRouter,
 * then a direct Anthropic key, then a direct OpenAI key. Every credential
 * read here is registered for redaction, whether or not it is selected.
 */
function resolveAuth(env: NodeJS.ProcessEnv): { auth: ResolvedAuth; warnings: string[] } {
  const warnings: string[] = [];
  const token = env['CLAUDE_CODE_OAUTH_TOKEN'];
  const openrouterKey = env['SNITCH_API_KEY'] ?? env['OPENROUTER_API_KEY'];
  const anthropicKey = env['ANTHROPIC_API_KEY'];
  const openaiKey = env['OPENAI_API_KEY'];
  for (const value of [token, openrouterKey, anthropicKey, openaiKey]) registerSecret(value);

  if (token) {
    if (anthropicKey) {
      warnings.push(
        'Both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set. Snitch uses the subscription token and hides the API key from the Agent SDK for this run (the SDK would otherwise silently bill API credits). Unset ANTHROPIC_API_KEY to silence this warning.',
      );
    }
    return { auth: { kind: 'subscription', token }, warnings };
  }
  if (openrouterKey) return { auth: { kind: 'openrouter', apiKey: openrouterKey }, warnings };
  if (anthropicKey) return { auth: { kind: 'anthropic', apiKey: anthropicKey }, warnings };
  if (openaiKey) return { auth: { kind: 'openai', apiKey: openaiKey }, warnings };
  return { auth: { kind: 'none' }, warnings };
}

export function loadConfig(overrides: { model?: string; cwd?: string; promptTools?: boolean } = {}): SnitchConfig {
  const cwd = overrides.cwd ?? process.cwd();

  const envFile = path.join(cwd, '.env');
  if (fs.existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      // a malformed .env should not be fatal; the auth checks below will complain if needed
    }
  }

  const file = readConfigFile(cwd);
  const { auth, warnings } = resolveAuth(process.env);
  return {
    auth,
    model: overrides.model ?? file.model ?? DEFAULT_MODELS[auth.kind],
    baseUrl: file.baseUrl ?? 'https://openrouter.ai/api/v1',
    tokenBudget: file.tokenBudget ?? 200_000,
    maxIterations: file.maxIterations ?? 24,
    promptTools: overrides.promptTools ?? false,
    warnings,
  };
}

export function requireAuth(config: SnitchConfig): Exclude<ResolvedAuth, { kind: 'none' }> {
  if (config.auth.kind === 'none') {
    throw new SnitchError(
      'No credentials found. Either run on a Claude subscription (claude setup-token, then set CLAUDE_CODE_OAUTH_TOKEN) ' +
        'or set an API key: SNITCH_API_KEY / OPENROUTER_API_KEY (OpenRouter), ANTHROPIC_API_KEY, or OPENAI_API_KEY ' +
        '(environment or .env file).',
    );
  }
  return config.auth;
}
