import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../src/ui/App.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('App', () => {
  it('renders the title and exit hint', () => {
    const { lastFrame, unmount } = render(<App />);
    expect(lastFrame()).toContain('Snitch');
    expect(lastFrame()).toContain('press q or ctrl+c to exit');
    unmount();
  });

  it('echoes the last key pressed', async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    expect(lastFrame()).toContain('(none yet)');
    await tick();
    stdin.write('x');
    await tick();
    expect(lastFrame()).toContain('last key: x');
    unmount();
  });
});
