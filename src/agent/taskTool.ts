import type { LLMProvider } from '../llm/types.js';
import { createDefaultRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/types.js';
import { ToolError } from '../tools/types.js';
import { History } from './history.js';
import { runAgent } from './loop.js';
import { buildSystemPrompt } from './prompts.js';

export interface TaskToolDeps {
  /** Callback (not a value) so a /model switch mid-session reaches sub-agents. */
  getProvider: () => LLMProvider;
  maxIterations?: number;
  tokenBudget?: number;
}

interface TaskArgs {
  description: string;
  prompt: string;
}

/**
 * Spawns a fresh agent loop: new empty History with the same system prompt,
 * and a fresh default registry — which by construction does NOT contain this
 * tool, so sub-agents cannot recurse. Tool calls inside the sub-agent are
 * auto-approved: the human approved the spawn itself, which is why `task` is
 * approval-gated and previews the sub-agent's prompt.
 */
export function createTaskTool(deps: TaskToolDeps): Tool<TaskArgs> {
  return {
    name: 'task',
    description:
      'Spawn a sub-agent to handle a self-contained piece of work. It gets a fresh conversation and the same tools (except task itself), runs the given prompt to completion with tool calls auto-approved, and returns its final reply. Use it for work that would flood your own context, and give it a complete, standalone prompt.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short (3-7 word) label for what the sub-agent will do' },
        prompt: {
          type: 'string',
          description: 'The full task for the sub-agent. It cannot see your conversation — include everything it needs.',
        },
      },
      required: ['description', 'prompt'],
    },
    requiresApproval: true,
    preview(args) {
      const head = args.prompt.length > 300 ? `${args.prompt.slice(0, 300)}…` : args.prompt;
      return `sub-agent: ${args.description}\n(all tool calls inside run without further prompts)\n---\n${head}`;
    },
    async execute(args, context) {
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
        throw new ToolError('task needs a non-empty "prompt" for the sub-agent');
      }

      let finalText = '';
      let failure = '';
      const events = runAgent(args.prompt, {
        provider: deps.getProvider(),
        registry: createDefaultRegistry(), // no `task` inside — no recursion
        history: new History(buildSystemPrompt(context.cwd)),
        cwd: context.cwd,
        maxIterations: deps.maxIterations,
        tokenBudget: deps.tokenBudget,
        signal: context.signal, // Esc in the parent cancels the sub-agent too
      });
      for await (const event of events) {
        if (event.type === 'approval_required') {
          event.respond(true);
        } else if (event.type === 'assistant_message' && event.content.trim()) {
          finalText = event.content;
        } else if (event.type === 'done' && event.reason !== 'completed') {
          failure =
            event.reason === 'error'
              ? `Sub-agent failed: ${event.error}`
              : `Sub-agent stopped early (${event.reason.replace('_', ' ')}).`;
        }
      }

      if (failure) return finalText ? `${failure}\nIts last reply:\n${finalText}` : failure;
      return finalText || '(sub-agent finished without a text reply)';
    },
  };
}
