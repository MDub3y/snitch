#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { loadConfig, requireApiKey } from './config.js';
import { runHeadless } from './headless.js';
import { runScan, type ScanOptions } from './security/scan.js';
import { SEVERITIES, type Severity } from './security/findings.js';
import { type ProviderName } from './config.js';
import { App } from './ui/App.js';
import { SnitchError } from './util/errors.js';

const PROVIDERS: readonly ProviderName[] = ['anthropic', 'openrouter'];

function parseProvider(value: string | undefined): ProviderName {
  if (!value || !PROVIDERS.includes(value as ProviderName)) {
    throw new SnitchError(`--provider requires one of: ${PROVIDERS.join(', ')}`);
  }
  return value as ProviderName;
}

interface CliArgs {
  headless: boolean;
  promptTools: boolean;
  yes: boolean;
  plan: boolean;
  model?: string;
  provider?: ProviderName;
  prompt: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { headless: false, promptTools: false, yes: false, plan: false, prompt: '' };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--headless') args.headless = true;
    else if (arg === '--prompt-tools') args.promptTools = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--plan') args.plan = true;
    else if (arg === '--model') {
      const value = argv[++i];
      if (!value) throw new SnitchError('--model requires a value, e.g. --model claude-opus-5-5');
      args.model = value;
    } else if (arg === '--provider') {
      args.provider = parseProvider(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: snitch [--headless "<prompt>"] [--yes] [--plan] [--model <id>] [--provider anthropic|openrouter] [--prompt-tools]',
      );
      process.exit(0);
    } else positional.push(arg);
  }
  args.prompt = positional.join(' ');
  return args;
}

interface ScanCliArgs extends ScanOptions {
  model?: string;
  provider?: ProviderName;
  promptTools: boolean;
}

function parseScanArgs(argv: string[]): ScanCliArgs {
  const args: ScanCliArgs = { path: '.', failOn: 'high', promptTools: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--diff') {
      const value = argv[++i];
      if (!value) throw new SnitchError('--diff requires a git ref, e.g. --diff origin/main');
      args.diff = value;
    } else if (arg === '--sarif') {
      const value = argv[++i];
      if (!value) throw new SnitchError('--sarif requires a file path, e.g. --sarif snitch.sarif');
      args.sarifPath = value;
    } else if (arg === '--report') {
      const value = argv[++i];
      if (!value) throw new SnitchError('--report requires a file path, e.g. --report report.md');
      args.reportPath = value;
    } else if (arg === '--fail-on') {
      const value = argv[++i];
      if (!value || !SEVERITIES.includes(value as Severity)) {
        throw new SnitchError(`--fail-on requires one of: ${SEVERITIES.join(', ')}`);
      }
      args.failOn = value as Severity;
    } else if (arg === '--model') {
      const value = argv[++i];
      if (!value) throw new SnitchError('--model requires a value');
      args.model = value;
    } else if (arg === '--provider') {
      args.provider = parseProvider(argv[++i]);
    } else if (arg === '--prompt-tools') {
      args.promptTools = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: snitch scan [path] [--diff <ref>] [--sarif <file>] [--report <file>] [--fail-on <severity>] [--model <id>] [--provider anthropic|openrouter] [--prompt-tools]',
      );
      process.exit(0);
    } else positional.push(arg);
  }
  if (positional[0]) args.path = positional[0];
  return args;
}

try {
  const rawArgv = process.argv.slice(2);

  if (rawArgv[0] === 'scan') {
    const scanArgs = parseScanArgs(rawArgv.slice(1));
    const config = loadConfig({ provider: scanArgs.provider, model: scanArgs.model, promptTools: scanArgs.promptTools });
    const { failed } = await runScan(config, scanArgs);
    if (failed) process.exitCode = 1;
  } else {
  const args = parseArgs(rawArgv);
  const config = loadConfig({ provider: args.provider, model: args.model, promptTools: args.promptTools });

  if (args.headless) {
    if (!args.prompt) throw new SnitchError('Headless mode needs a prompt: snitch --headless "your task"');
    await runHeadless(args.prompt, config, { yes: args.yes, plan: args.plan });
  } else {
    if (!process.stdin.isTTY) {
      throw new SnitchError(
        'Interactive mode requires a TTY (run inside a terminal such as Windows Terminal), or use --headless "<prompt>".',
      );
    }
    // Fail fast before Ink takes over the screen. The Anthropic provider
    // resolves its own credentials (key / token / OAuth profile), so only the
    // OpenRouter path needs a key up front.
    if (config.provider === 'openrouter') requireApiKey(config);
    const { waitUntilExit } = render(<App config={config} />);
    await waitUntilExit();
  }
  }
} catch (error) {
  if (error instanceof SnitchError) {
    console.error(`snitch: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
