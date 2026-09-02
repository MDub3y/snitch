#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { loadConfig } from './config.js';
import { runHeadless } from './headless.js';
import { App } from './ui/App.js';
import { SnitchError } from './util/errors.js';

interface CliArgs {
  headless: boolean;
  model?: string;
  prompt: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { headless: false, prompt: '' };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--headless') args.headless = true;
    else if (arg === '--model') {
      const value = argv[++i];
      if (!value) throw new SnitchError('--model requires a value, e.g. --model poolside/laguna-s-2.1:free');
      args.model = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: snitch [--headless "<prompt>"] [--model <id>]');
      process.exit(0);
    } else positional.push(arg);
  }
  args.prompt = positional.join(' ');
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ model: args.model });

  if (args.headless) {
    if (!args.prompt) throw new SnitchError('Headless mode needs a prompt: snitch --headless "your task"');
    await runHeadless(args.prompt, config);
  } else {
    if (!process.stdin.isTTY) {
      throw new SnitchError(
        'Interactive mode requires a TTY (run inside a terminal such as Windows Terminal), or use --headless "<prompt>".',
      );
    }
    const { waitUntilExit } = render(<App />);
    await waitUntilExit();
  }
} catch (error) {
  if (error instanceof SnitchError) {
    console.error(`snitch: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
