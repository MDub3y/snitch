#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';

if (!process.stdin.isTTY) {
  // Headless mode arrives in Phase 2; the Ink TUI needs a real terminal.
  console.error('snitch: interactive mode requires a TTY (run inside a terminal such as Windows Terminal).');
  process.exit(1);
}

const { waitUntilExit } = render(<App />);
await waitUntilExit();
