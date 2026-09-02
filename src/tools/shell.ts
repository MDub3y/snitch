import { spawn } from 'node:child_process';
import { resolvePath } from './fs.js';
import type { Tool } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 30_000;

/**
 * Kills a process and its children. On Windows, `child.kill()` leaves the
 * process tree alive, so use taskkill /T /F instead.
 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL'); // negative pid → process group (needs detached)
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

interface RunArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

const runCommand: Tool<RunArgs> = {
  name: 'run_command',
  description:
    'Run a shell command and return its exit code and combined output. Times out after 60s by default. The user must approve every command.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute' },
      cwd: { type: 'string', description: 'Working directory for the command (default: the working directory)' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 60000)' },
    },
    required: ['command'],
  },
  requiresApproval: true,
  preview(args, context) {
    return `$ ${args.command}${args.cwd ? `   (in ${resolvePath(args.cwd, context)})` : ''}`;
  },
  execute(args, context) {
    const cwd = resolvePath(args.cwd ?? '.', context);
    const timeoutMs = Math.max(1, args.timeout_ms ?? DEFAULT_TIMEOUT_MS);

    return new Promise((resolve) => {
      const child = spawn(args.command, {
        shell: true,
        cwd,
        detached: process.platform !== 'win32', // own process group, so the whole tree can be killed
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let truncated = false;
      const append = (chunk: Buffer) => {
        if (output.length >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        output += chunk.toString('utf8');
        if (output.length > MAX_OUTPUT_BYTES) {
          output = output.slice(0, MAX_OUTPUT_BYTES);
          truncated = true;
        }
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid);
      }, timeoutMs);
      const onAbort = () => {
        aborted = true;
        if (child.pid) killTree(child.pid);
      };
      context.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode: number | null, error?: Error) => {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
        const parts = [
          timedOut ? `Command timed out after ${timeoutMs}ms and was killed.` : '',
          aborted ? 'Command was cancelled by the user.' : '',
          error ? `Failed to run command: ${error.message}` : `exit code: ${exitCode ?? 'unknown'}`,
          output.trim() ? output.trimEnd() : '(no output)',
          truncated ? `(output truncated at ${MAX_OUTPUT_BYTES} bytes)` : '',
        ];
        resolve(parts.filter(Boolean).join('\n'));
      };

      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));
    });
  },
};

export function createShellTools(): Tool[] {
  return [runCommand];
}
