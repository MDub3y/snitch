import readline from 'node:readline/promises';
import { History } from './agent/history.js';
import { runAgent } from './agent/loop.js';
import { buildSystemPrompt } from './agent/prompts.js';
import { createTaskTool } from './agent/taskTool.js';
import type { SnitchConfig } from './config.js';
import { requireApiKey } from './config.js';
import { OpenRouterProvider } from './llm/openrouter.js';
import { PromptToolAdapter } from './llm/promptTools.js';
import { createDefaultRegistry } from './tools/registry.js';

/**
 * Headless runner: one task in, agent loop with y/n approvals on stdin,
 * streamed output on stdout, status on stderr. The Ink TUI (Phase 5) consumes
 * the same AgentEvent stream.
 */
export interface HeadlessOptions {
  /** Auto-approve every tool call (--yes). For scripted/piped runs where stdin cannot answer prompts. */
  yes?: boolean;
}

export async function runHeadless(prompt: string, config: SnitchConfig, options: HeadlessOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const openRouter = new OpenRouterProvider({
    apiKey: requireApiKey(config),
    model: config.model,
    baseUrl: config.baseUrl,
  });
  const provider = config.promptTools ? new PromptToolAdapter(openRouter) : openRouter;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  let exitCode = 0;
  try {
    const registry = createDefaultRegistry();
    registry.register(
      createTaskTool({ getProvider: () => provider, maxIterations: config.maxIterations, tokenBudget: config.tokenBudget }),
    );
    const events = runAgent(prompt, {
      provider,
      registry,
      history: new History(buildSystemPrompt(cwd)),
      cwd,
      maxIterations: config.maxIterations,
      tokenBudget: config.tokenBudget,
      signal: controller.signal,
      onRetry: ({ status, attempt, maxAttempts, delayMs }) =>
        process.stderr.write(`[snitch] ${status} from OpenRouter, retry ${attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s...\n`),
    });

    for await (const event of events) {
      switch (event.type) {
        case 'text_delta':
          process.stdout.write(event.delta);
          break;
        case 'assistant_message':
          process.stdout.write('\n');
          break;
        case 'tool_call_start':
          process.stderr.write(`\n[tool] ${event.call.name} ${event.call.rawArguments.slice(0, 200)}\n`);
          break;
        case 'approval_required': {
          if (options.yes) {
            process.stderr.write(`${event.preview}\n[snitch] auto-approved (--yes)\n`);
            event.respond(true);
            break;
          }
          let answer = '';
          try {
            answer = await rl.question(`${event.preview}\napprove? [y/N] `);
          } catch {
            // stdin ended (piped input exhausted) — readline is closed; deny instead of crashing
            process.stderr.write('[snitch] stdin closed, denying tool call (use --yes to auto-approve)\n');
          }
          event.respond(/^y(es)?$/i.test(answer.trim()));
          break;
        }
        case 'tool_result': {
          const head = event.result.split('\n').slice(0, 5).join('\n');
          process.stderr.write(`[result] ${head}${event.result.length > head.length ? '\n…' : ''}\n`);
          break;
        }
        case 'usage':
          break; // totals reported at the end
        case 'done':
          if (event.reason === 'completed') break;
          exitCode = 1;
          process.stderr.write(
            event.reason === 'max_iterations'
              ? `\n[snitch] stopped: hit the ${config.maxIterations}-iteration limit\n`
              : event.reason === 'cancelled'
                ? '\n[snitch] cancelled\n'
                : `\n[snitch] error: ${event.error}\n`,
          );
          break;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    rl.close();
  }
  if (exitCode !== 0) process.exitCode = exitCode;
}
