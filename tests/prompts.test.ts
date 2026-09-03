import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/prompts.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-prompts-'));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('buildSystemPrompt', () => {
  it('contains identity, environment, and a cwd listing with directories first', () => {
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'a-dir'));

    const prompt = buildSystemPrompt(dir);
    expect(prompt).toContain('You are Snitch');
    expect(prompt).toContain(`Working directory: ${dir}`);
    expect(prompt).toContain('shell commands run under');
    expect(prompt.indexOf('a-dir/')).toBeGreaterThan(0);
    expect(prompt.indexOf('a-dir/')).toBeLessThan(prompt.indexOf('b.txt'));
  });

  it('includes SNITCH.md contents under a project instructions heading', () => {
    fs.writeFileSync(path.join(dir, 'SNITCH.md'), 'Always run npm test before finishing.');
    const prompt = buildSystemPrompt(dir);
    expect(prompt).toContain('Project instructions (from SNITCH.md):');
    expect(prompt).toContain('Always run npm test before finishing.');
  });

  it('omits the project instructions section when SNITCH.md is absent or empty', () => {
    expect(buildSystemPrompt(dir)).not.toContain('Project instructions');
    fs.writeFileSync(path.join(dir, 'SNITCH.md'), '   \n');
    expect(buildSystemPrompt(dir)).not.toContain('Project instructions');
  });

  it('caps a huge SNITCH.md instead of blowing the token budget', () => {
    fs.writeFileSync(path.join(dir, 'SNITCH.md'), 'x'.repeat(50_000));
    const prompt = buildSystemPrompt(dir);
    expect(prompt).toContain('SNITCH.md truncated');
    expect(prompt.length).toBeLessThan(20_000);
  });
});
