import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnitchConfig } from '../src/config.js';
import type { ChatOptions, StreamEvent } from '../src/llm/types.js';
import { createDefaultRegistry } from '../src/tools/registry.js';
import { App } from '../src/ui/App.js';
import { FakeProvider, textTurn, toolTurn } from './helpers/fakeProvider.js';

const config: SnitchConfig = {
  apiKey: 'test-key',
  model: 'fake/model',
  baseUrl: 'http://localhost',
  tokenBudget: 200_000,
  maxIterations: 24,
  promptTools: false,
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-app-'));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function renderApp(provider: FakeProvider) {
  return render(<App config={config} provider={provider} registry={createDefaultRegistry()} cwd={dir} />);
}

const frame = (r: { lastFrame: () => string | undefined }) => r.lastFrame() ?? '';

/** Ink needs a beat between stdin writes to parse them as separate keypresses. */
async function type(r: { stdin: { write: (s: string) => void } }, ...inputs: string[]) {
  for (const input of inputs) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    r.stdin.write(input);
  }
}

describe('App', () => {
  it('animates the snitch banner to full span and keeps it after /clear', async () => {
    const r = renderApp(new FakeProvider([]));
    expect(frame(r)).toContain('S  N  I  T  C  H'); // wordmark from frame one
    // full wing span appears once the unfurl finishes (~1s)
    await vi.waitFor(() => expect(frame(r)).toContain(',g$$g,_'), { timeout: 3000 });

    await type(r, '/clear', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain(',g$$g,_'));
    r.unmount();
  });

  it('renders the input prompt and status bar', () => {
    const r = renderApp(new FakeProvider([]));
    expect(frame(r)).toContain('describe a task…');
    expect(frame(r)).toContain('· ready');
    expect(frame(r)).toContain('fake/model');
    r.unmount();
  });

  it('runs a text-only task and shows the reply in the transcript', async () => {
    const r = renderApp(new FakeProvider([textTurn('All done!')]));
    await type(r, 'say something', '\r');

    await vi.waitFor(() => expect(frame(r)).toContain('All done!'));
    expect(frame(r)).toContain('> say something');
    await vi.waitFor(() => expect(frame(r)).toContain('· ready'));
    r.unmount();
  });

  it('shows an approval card and records a denial without executing', async () => {
    const provider = new FakeProvider([
      toolTurn([{ id: 'call_1', name: 'write_file', args: '{"path":"out.txt","content":"hi"}' }]),
      textTurn('okay, skipped it'),
    ]);
    const r = renderApp(provider);
    await type(r, 'write a file', '\r');

    await vi.waitFor(() => expect(frame(r)).toContain('approve? [y]es / [n]o'));
    expect(frame(r)).toContain('[tool] write_file');
    await type(r, 'n');

    await vi.waitFor(() => expect(frame(r)).toContain('okay, skipped it'));
    expect(frame(r)).toContain('write_file denied');
    expect(fs.existsSync(path.join(dir, 'out.txt'))).toBe(false);
    r.unmount();
  });

  it('executes an approved tool call and shows its result', async () => {
    const provider = new FakeProvider([
      toolTurn([{ id: 'call_1', name: 'write_file', args: '{"path":"out.txt","content":"hi"}' }]),
      textTurn('wrote it'),
    ]);
    const r = renderApp(provider);
    await type(r, 'write a file', '\r');

    await vi.waitFor(() => expect(frame(r)).toContain('approve? [y]es / [n]o'));
    await type(r, 'y');

    await vi.waitFor(() => expect(frame(r)).toContain('wrote it'));
    expect(frame(r)).toContain('write_file ok');
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('hi');
    r.unmount();
  });

  it('treats bare exit words as quit, not as a task for the model', async () => {
    const provider = new FakeProvider([textTurn('should never be sent')]);
    const r = renderApp(provider);
    await type(r, 'exit', '\r');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(provider.seenMessages).toHaveLength(0); // nothing went to the model
    expect(frame(r)).not.toContain('> exit'); // not recorded as a user task
    r.unmount();
  });

  it('handles /help and unknown slash commands', async () => {
    const r = renderApp(new FakeProvider([]));
    await type(r, '/help', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('/clear — reset the conversation'));

    await type(r, '/nope', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('unknown command /nope'));
    r.unmount();
  });

  it('queues input typed while the agent is working and runs it afterwards', async () => {
    // Holds the first turn open until release() so the test can type mid-run.
    class GatedProvider extends FakeProvider {
      release!: () => void;
      private readonly gate = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      private first = true;
      async *chat(options: ChatOptions): AsyncIterable<StreamEvent> {
        if (this.first) {
          this.first = false;
          await this.gate;
        }
        yield* super.chat(options);
      }
    }
    const provider = new GatedProvider([textTurn('first done'), textTurn('second done')]);
    const r = renderApp(provider);

    await type(r, 'first task', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('working'));

    await type(r, 'second task', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('[queued] second task'));
    expect(frame(r)).not.toContain('first done'); // still gated

    provider.release();
    await vi.waitFor(() => expect(frame(r)).toContain('second done'));
    expect(frame(r)).toContain('first done');
    expect(frame(r)).toContain('> second task');
    expect(frame(r)).not.toContain('[queued]'); // queue drained
    r.unmount();
  });

  it('plan mode blocks mutating tools and shows a status badge', async () => {
    const provider = new FakeProvider([
      toolTurn([{ id: 'call_1', name: 'write_file', args: '{"path":"out.txt","content":"hi"}' }]),
      textTurn('here is the plan instead'),
    ]);
    const r = renderApp(provider);
    await type(r, '/plan', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('plan mode on'));
    expect(frame(r)).toContain('[plan]');

    await type(r, 'change something', '\r');
    // write_file is not in the read-only registry: no approval card, an error result instead
    await vi.waitFor(() => expect(frame(r)).toContain('here is the plan instead'));
    expect(frame(r)).toContain('write_file error');
    expect(frame(r)).not.toContain('approve?');
    expect(fs.existsSync(path.join(dir, 'out.txt'))).toBe(false);

    await type(r, '/plan', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('plan mode off'));
    r.unmount();
  });

  it('/compact reports when the conversation is too short to compact', async () => {
    const r = renderApp(new FakeProvider([textTurn('reply one')]));
    await type(r, 'a task', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('reply one'));

    await type(r, '/compact', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('nothing to compact yet'));
    r.unmount();
  });

  it('/compact summarizes a long conversation through the model', async () => {
    const turns = Array.from({ length: 5 }, (_, i) => textTurn(`reply ${i}`));
    const provider = new FakeProvider([...turns, textTurn('a compact summary')]);
    const r = renderApp(provider);
    for (let i = 0; i < 5; i++) {
      await type(r, `task number ${i}`, '\r');
      await vi.waitFor(() => expect(frame(r)).toContain(`reply ${i}`));
    }
    await type(r, '/compact', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('history compacted'));
    // the summarizer call saw the old exchanges
    expect(JSON.stringify(provider.seenMessages.at(-1))).toContain('task number 0');
    r.unmount();
  });

  it('/clear resets the transcript and /model switches the model label', async () => {
    const r = renderApp(new FakeProvider([textTurn('remembered reply')]));
    await type(r, 'first task', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('remembered reply'));

    await type(r, '/clear', '\r');
    await vi.waitFor(() => expect(frame(r)).not.toContain('remembered reply'));

    await type(r, '/model other/model', '\r');
    await vi.waitFor(() => expect(frame(r)).toContain('model set to other/model'));
    r.unmount();
  });
});
