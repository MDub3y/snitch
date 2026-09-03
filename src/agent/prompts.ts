import fs from 'node:fs';
import path from 'node:path';
import { defaultShell } from '../tools/shell.js';

const MAX_LISTING_ENTRIES = 50;
const MAX_INSTRUCTIONS_CHARS = 10_000;

/** Top-level listing of the working directory, directories first, capped. */
function listCwd(cwd: string): string {
  try {
    const entries = fs
      .readdirSync(cwd, { withFileTypes: true })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const shown = entries
      .slice(0, MAX_LISTING_ENTRIES)
      .map((entry) => `  ${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (entries.length > MAX_LISTING_ENTRIES) {
      shown.push(`  ... and ${entries.length - MAX_LISTING_ENTRIES} more entries`);
    }
    return shown.length > 0 ? shown.join('\n') : '  (empty)';
  } catch {
    return '  (could not list directory)';
  }
}

/** Full SNITCH.md contents when present, size-capped so it can never eat the token budget. */
function projectInstructions(cwd: string): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, 'SNITCH.md'), 'utf8').trim();
  } catch {
    return '';
  }
  if (!text) return '';
  if (text.length > MAX_INSTRUCTIONS_CHARS) {
    text = `${text.slice(0, MAX_INSTRUCTIONS_CHARS)}\n(SNITCH.md truncated at ${MAX_INSTRUCTIONS_CHARS} characters)`;
  }
  return `\n\nProject instructions (from SNITCH.md):\n${text}`;
}

/**
 * Built once at startup (and again on /clear): identity + behaviour, the
 * environment block, and the project's SNITCH.md if it has one.
 */
export function buildSystemPrompt(cwd: string): string {
  return `You are Snitch, a terminal coding agent. You help the user with software tasks by calling tools in a loop until the task is done, then you reply with a short summary.

Environment:
- Working directory: ${cwd}
- Platform: ${process.platform === 'win32' ? 'Windows' : process.platform} (shell commands run under ${defaultShell().name})
- Files in the working directory:
${listCwd(cwd)}

Rules:
- Prefer tools over guessing: read files before editing them, and verify your work (e.g. run the code or tests) when practical.
- Use edit_file for small changes and write_file only for new files or full rewrites.
- File writes, edits and shell commands require the user's approval; if the user denies one, adapt or ask instead of retrying the same call.
- Keep replies concise. When the task is complete, state what you did in a sentence or two — do not call more tools.${projectInstructions(cwd)}`;
}
