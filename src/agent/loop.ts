import type { LLMProvider, RetryInfo, Usage, WireToolCall } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { History } from './history.js';

export interface ParsedToolCall {
  id: string;
  name: string;
  /** Raw JSON string as sent by the model. */
  rawArguments: string;
  /** Parsed arguments, or undefined when rawArguments was malformed. */
  args?: unknown;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'assistant_message'; content: string }
  | { type: 'tool_call_start'; call: ParsedToolCall }
  | { type: 'approval_required'; call: ParsedToolCall; preview: string; respond: (approved: boolean) => void }
  | { type: 'tool_result'; callId: string; name: string; result: string }
  | { type: 'usage'; usage: Usage; totals: UsageTotals }
  | { type: 'done'; reason: 'completed' | 'max_iterations' | 'cancelled' | 'error'; error?: string };

export interface AgentOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  history: History;
  cwd: string;
  maxIterations?: number;
  tokenBudget?: number;
  signal?: AbortSignal;
  onRetry?: (info: RetryInfo) => void;
}

export const DENIED_RESULT = 'The user denied this tool call. Adapt your approach or ask them instead of retrying it.';

function parseCall(call: WireToolCall): ParsedToolCall {
  const parsed: ParsedToolCall = { id: call.id, name: call.function.name, rawArguments: call.function.arguments };
  const raw = call.function.arguments.trim();
  if (raw === '') {
    parsed.args = {};
    return parsed;
  }
  try {
    parsed.args = JSON.parse(raw);
  } catch {
    // leave args undefined; the loop reports the parse failure to the model
  }
  return parsed;
}

/**
 * Runs one user turn of the agent: model -> tool calls -> results -> model,
 * until the model stops calling tools or a guard triggers. UI-agnostic: both
 * the headless runner and the Ink TUI consume this event stream. Approvals
 * suspend the generator until the consumer calls `respond`.
 */
export async function* runAgent(userMessage: string, options: AgentOptions): AsyncGenerator<AgentEvent> {
  const { provider, registry, history, cwd, signal } = options;
  const maxIterations = options.maxIterations ?? 24;
  const tokenBudget = options.tokenBudget ?? 200_000;
  const totals: UsageTotals = { promptTokens: 0, completionTokens: 0, cost: 0 };

  history.addUser(userMessage);

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let text = '';
      const wireCalls: WireToolCall[] = [];
      let finishReason = 'stop';

      const stream = provider.chat({
        messages: history.toMessages(tokenBudget),
        tools: registry.toSpecs(),
        signal,
        onRetry: options.onRetry,
      });
      for await (const event of stream) {
        if (event.type === 'text') {
          text += event.delta;
          yield { type: 'text_delta', delta: event.delta };
        } else if (event.type === 'tool_call') {
          wireCalls.push(event.call);
        } else if (event.type === 'usage') {
          totals.promptTokens += event.usage.promptTokens;
          totals.completionTokens += event.usage.completionTokens;
          totals.cost += event.usage.cost ?? 0;
          yield { type: 'usage', usage: event.usage, totals: { ...totals } };
        } else if (event.type === 'done') {
          finishReason = event.finishReason;
        }
      }

      history.addAssistant(text || null, wireCalls);
      if (text) yield { type: 'assistant_message', content: text };

      if (wireCalls.length === 0) {
        if (finishReason === 'length') {
          yield { type: 'done', reason: 'error', error: 'The model hit its output-length limit.' };
        } else {
          yield { type: 'done', reason: 'completed' };
        }
        return;
      }

      for (const wireCall of wireCalls) {
        const call = parseCall(wireCall);
        yield { type: 'tool_call_start', call };

        let result: string;
        if (call.args === undefined) {
          result = `Error: could not parse tool arguments as JSON: ${call.rawArguments.slice(0, 200)}`;
        } else {
          const tool = registry.get(call.name);
          let approved = true;
          if (tool?.requiresApproval) {
            const preview = tool.preview
              ? await tool.preview(call.args, { cwd, signal })
              : `${call.name} ${JSON.stringify(call.args)}`;
            let respond!: (ok: boolean) => void;
            const decision = new Promise<boolean>((resolve) => {
              respond = resolve;
            });
            yield { type: 'approval_required', call, preview, respond };
            approved = await decision;
          }
          result = approved ? await registry.execute(call.name, call.args, { cwd, signal }) : DENIED_RESULT;
        }

        history.addToolResult(call.id, result);
        yield { type: 'tool_result', callId: call.id, name: call.name, result };
      }
    }

    yield { type: 'done', reason: 'max_iterations' };
  } catch (error) {
    if (signal?.aborted) {
      yield { type: 'done', reason: 'cancelled' };
      return;
    }
    yield { type: 'done', reason: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}
