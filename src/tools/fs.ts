import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext } from './types.js';
import { ToolError } from './types.js';

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;

export function resolvePath(p: string, context: ToolContext): string {
  return path.resolve(context.cwd, p);
}

export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

async function readTextFile(absPath: string): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ToolError(`File not found: ${absPath}`);
    if (code === 'EISDIR') throw new ToolError(`${absPath} is a directory — use list_dir instead`);
    throw error;
  }
  if (looksBinary(buffer)) throw new ToolError(`${absPath} looks like a binary file`);
  return buffer.toString('utf8');
}

interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

const readFile: Tool<ReadArgs> = {
  name: 'read_file',
  description:
    'Read a text file. Returns numbered lines. Use offset/limit for large files (defaults to the first 2000 lines).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute, or relative to the working directory)' },
      offset: { type: 'number', description: '1-based line number to start from (default 1)' },
      limit: { type: 'number', description: 'Maximum lines to return (default 2000)' },
    },
    required: ['path'],
  },
  requiresApproval: false,
  async execute(args, context) {
    const absPath = resolvePath(args.path, context);
    const lines = (await readTextFile(absPath)).split('\n');
    const offset = Math.max(1, args.offset ?? 1);
    const limit = Math.max(1, args.limit ?? DEFAULT_READ_LIMIT);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (slice.length === 0) return `(no lines at offset ${offset}; file has ${lines.length} lines)`;

    const numbered = slice
      .map((line, i) => {
        const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… (line truncated)` : line;
        return `${String(offset + i).padStart(5)}: ${text}`;
      })
      .join('\n');
    const remaining = lines.length - (offset - 1 + slice.length);
    return remaining > 0 ? `${numbered}\n(${remaining} more lines — use offset to continue)` : numbered;
  },
};

interface WriteArgs {
  path: string;
  content: string;
}

const writeFile: Tool<WriteArgs> = {
  name: 'write_file',
  description: 'Create or overwrite a text file with the given content. Parent directories are created as needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute, or relative to the working directory)' },
      content: { type: 'string', description: 'Full new file content' },
    },
    required: ['path', 'content'],
  },
  requiresApproval: true,
  async preview(args, context) {
    const absPath = resolvePath(args.path, context);
    const newLines = args.content.split('\n').length;
    let header = `create ${absPath} (${newLines} lines)`;
    try {
      const existing = await fs.readFile(absPath, 'utf8');
      header = `overwrite ${absPath} (${existing.split('\n').length} lines -> ${newLines} lines)`;
    } catch {
      // new file
    }
    const head = args.content.split('\n').slice(0, 20).join('\n');
    return `${header}\n---\n${head}${newLines > 20 ? '\n…' : ''}`;
  },
  async execute(args, context) {
    const absPath = resolvePath(args.path, context);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, args.content, 'utf8');
    return `Wrote ${args.content.length} characters to ${absPath}`;
  },
};

interface EditArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

const editFile: Tool<EditArgs> = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must match exactly once (or pass replace_all). Prefer this over write_file for small changes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute, or relative to the working directory)' },
      old_string: { type: 'string', description: 'Exact text to replace (must be unique unless replace_all)' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  requiresApproval: true,
  preview(args, context) {
    const absPath = resolvePath(args.path, context);
    return `edit ${absPath}\n--- remove\n${args.old_string}\n+++ add\n${args.new_string}`;
  },
  async execute(args, context) {
    const absPath = resolvePath(args.path, context);
    const content = await readTextFile(absPath);
    if (args.old_string === args.new_string) throw new ToolError('old_string and new_string are identical');

    const occurrences = countOccurrences(content, args.old_string);
    if (occurrences === 0) throw new ToolError(`old_string not found in ${absPath}`);
    if (occurrences > 1 && !args.replace_all) {
      throw new ToolError(
        `old_string appears ${occurrences} times in ${absPath} — make it unique with more context, or pass replace_all`,
      );
    }

    const updated = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string);
    await fs.writeFile(absPath, updated, 'utf8');
    return `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${absPath}`;
  },
};

interface ListArgs {
  path?: string;
}

const listDir: Tool<ListArgs> = {
  name: 'list_dir',
  description: 'List the entries of a directory (directories first, with file sizes).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path (default: the working directory)' },
    },
  },
  requiresApproval: false,
  async execute(args, context) {
    const absPath = resolvePath(args.path ?? '.', context);
    let entries;
    try {
      entries = await fs.readdir(absPath, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new ToolError(`Directory not found: ${absPath}`);
      if (code === 'ENOTDIR') throw new ToolError(`${absPath} is a file — use read_file instead`);
      throw error;
    }
    if (entries.length === 0) return `(empty directory: ${absPath})`;

    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const rows = await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory()) return `${entry.name}/`;
        const size = await fs
          .stat(path.join(absPath, entry.name))
          .then((s) => s.size)
          .catch(() => 0);
        return `${entry.name}  (${size} bytes)`;
      }),
    );
    return rows.join('\n');
  },
};

export function createFsTools(): Tool[] {
  return [readFile, writeFile, editFile, listDir];
}
