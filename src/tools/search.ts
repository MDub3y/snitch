import fs from 'node:fs/promises';
import path from 'node:path';
import { glob as tinyglob } from 'tinyglobby';
import { looksBinary, resolvePath } from './fs.js';
import type { Tool, ToolContext } from './types.js';
import { ToolError } from './types.js';

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**'];
const GLOB_CAP = 200;
const GREP_FILE_CAP = 2000;
const MAX_GREP_FILE_SIZE = 1_000_000;

async function findFiles(pattern: string, context: ToolContext, basePath?: string): Promise<string[]> {
  const cwd = resolvePath(basePath ?? '.', context);
  return tinyglob(pattern, { cwd, ignore: IGNORE, onlyFiles: true, dot: false, absolute: true });
}

interface GlobArgs {
  pattern: string;
  path?: string;
}

const globTool: Tool<GlobArgs> = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/**/config.*"). Results are newest-first. Ignores node_modules, .git and dist.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match file paths against' },
      path: { type: 'string', description: 'Directory to search in (default: the working directory)' },
    },
    required: ['pattern'],
  },
  requiresApproval: false,
  async execute(args, context) {
    const files = await findFiles(args.pattern, context, args.path);
    if (files.length === 0) return `No files match ${args.pattern}`;

    const withMtime = await Promise.all(
      files.map(async (file) => ({ file, mtime: await fs.stat(file).then((s) => s.mtimeMs).catch(() => 0) })),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const shown = withMtime.slice(0, GLOB_CAP).map((entry) => entry.file);
    const suffix = files.length > GLOB_CAP ? `\n(${files.length - GLOB_CAP} more matches not shown)` : '';
    return shown.join('\n') + suffix;
  },
};

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  max_results?: number;
}

const grepTool: Tool<GrepArgs> = {
  name: 'grep',
  description:
    'Search file contents with a JavaScript regular expression. Returns "file:line: text" matches. Skips binary and very large files.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regex to search for' },
      path: { type: 'string', description: 'Directory to search in (default: the working directory)' },
      glob: { type: 'string', description: 'Only search files matching this glob (e.g. "**/*.ts")' },
      max_results: { type: 'number', description: 'Maximum matching lines to return (default 100)' },
    },
    required: ['pattern'],
  },
  requiresApproval: false,
  async execute(args, context) {
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern);
    } catch (error) {
      throw new ToolError(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
    }
    const maxResults = Math.max(1, args.max_results ?? 100);
    const searchRoot = resolvePath(args.path ?? '.', context);
    const files = (await findFiles(args.glob ?? '**/*', context, args.path)).slice(0, GREP_FILE_CAP);

    const matches: string[] = [];
    let searched = 0;
    for (const file of files) {
      if (matches.length >= maxResults) break;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size > MAX_GREP_FILE_SIZE) continue;
      const buffer = await fs.readFile(file).catch(() => null);
      if (!buffer || looksBinary(buffer)) continue;
      searched++;

      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (regex.test(lines[i]!)) {
          const relative = path.relative(searchRoot, file) || file;
          matches.push(`${relative}:${i + 1}: ${lines[i]!.trimEnd().slice(0, 300)}`);
        }
      }
    }

    if (matches.length === 0) return `No matches for /${args.pattern}/ (${searched} files searched)`;
    const suffix = matches.length >= maxResults ? `\n(stopped at ${maxResults} results — refine the pattern)` : '';
    return matches.join('\n') + suffix;
  },
};

export function createSearchTools(): Tool[] {
  return [globTool, grepTool];
}
