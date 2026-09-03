import React, { useMemo, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { History } from '../agent/history.js';
import { runAgent, type UsageTotals } from '../agent/loop.js';
import { buildSystemPrompt } from '../agent/prompts.js';
import type { SnitchConfig } from '../config.js';
import { requireApiKey } from '../config.js';
import { OpenRouterProvider } from '../llm/openrouter.js';
import { PromptToolAdapter } from '../llm/promptTools.js';
import type { LLMProvider } from '../llm/types.js';
import { createDefaultRegistry, type ToolRegistry } from '../tools/registry.js';
import { InputBox } from './InputBox.js';
import { StatusBar } from './StatusBar.js';
import { ItemView, Transcript, type TranscriptItem } from './Transcript.js';
import { ToolCallCard } from './ToolCallCard.js';

type Mode = 'input' | 'working' | 'approval';

interface ActiveTool {
  name: string;
  detail: string;
  respond: ((approved: boolean) => void) | null;
}

export interface AppProps {
  config: SnitchConfig;
  /** Injectable for tests; defaults to OpenRouter with the configured model. */
  provider?: LLMProvider;
  registry?: ToolRegistry;
  cwd?: string;
}

function summarize(result: string): string {
  const firstLine = result.split('\n', 1)[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

const HELP_TEXT = [
  '/help — show this list',
  '/clear — reset the conversation and transcript',
  '/model <id> — switch model (no argument: show the current model)',
  '/exit — quit snitch (also: exit, quit, q, Ctrl+D)',
].join('\n');

/** Bare words every terminal tool is expected to honor instead of treating as a task. */
const EXIT_WORDS = new Set(['exit', 'quit', 'q', ':q']);

export function App({ config, provider: injectedProvider, registry: injectedRegistry, cwd: injectedCwd }: AppProps) {
  const cwd = injectedCwd ?? process.cwd();
  const { exit } = useApp();
  const [model, setModel] = useState(config.model);
  const provider = useMemo<LLMProvider>(() => {
    if (injectedProvider) return injectedProvider;
    const openRouter = new OpenRouterProvider({ apiKey: requireApiKey(config), model, baseUrl: config.baseUrl });
    return config.promptTools ? new PromptToolAdapter(openRouter) : openRouter;
  }, [injectedProvider, config, model]);
  const registry = useMemo(() => injectedRegistry ?? createDefaultRegistry(), [injectedRegistry]);
  const historyRef = useRef(new History(buildSystemPrompt(cwd)));
  const abortRef = useRef<AbortController | null>(null);

  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [generation, setGeneration] = useState(0); // remounts <Static> on /clear
  const [mode, setMode] = useState<Mode>('input');
  const [streamText, setStreamText] = useState('');
  const [activeTool, setActiveTool] = useState<ActiveTool | null>(null);
  const [totals, setTotals] = useState<UsageTotals>({ promptTokens: 0, completionTokens: 0, cost: 0 });
  const [status, setStatus] = useState<string | null>(null);

  const push = (item: TranscriptItem) => setItems((current) => [...current, item]);

  const runSlashCommand = (input: string) => {
    const [command, ...rest] = input.split(/\s+/);
    const argument = rest.join(' ');
    switch (command) {
      case '/help':
        push({ kind: 'info', text: HELP_TEXT });
        break;
      case '/clear':
        historyRef.current = new History(buildSystemPrompt(cwd));
        setItems([]);
        setGeneration((g) => g + 1);
        setTotals({ promptTokens: 0, completionTokens: 0, cost: 0 });
        break;
      case '/model':
        if (argument) {
          setModel(argument);
          push({ kind: 'info', text: `model set to ${argument}` });
        } else {
          push({ kind: 'info', text: `current model: ${provider.model}` });
        }
        break;
      case '/exit':
        exit();
        break;
      default:
        push({ kind: 'info', text: `unknown command ${command} — try /help` });
    }
  };

  const submit = (task: string) => {
    if (EXIT_WORDS.has(task.toLowerCase())) {
      exit();
      return;
    }
    if (task.startsWith('/')) {
      runSlashCommand(task);
      return;
    }
    push({ kind: 'user', text: task });
    setMode('working');
    setStatus(null);

    const controller = new AbortController();
    abortRef.current = controller;

    void (async () => {
      const events = runAgent(task, {
        provider,
        registry,
        history: historyRef.current,
        cwd,
        maxIterations: config.maxIterations,
        tokenBudget: config.tokenBudget,
        signal: controller.signal,
        onRetry: ({ status: httpStatus, attempt, maxAttempts, delayMs }) =>
          setStatus(`${httpStatus} from provider — retry ${attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s`),
      });

      for await (const event of events) {
        switch (event.type) {
          case 'text_delta':
            setStatus(null);
            setStreamText((current) => current + event.delta);
            break;
          case 'assistant_message':
            setStreamText('');
            push({ kind: 'assistant', text: event.content });
            break;
          case 'tool_call_start':
            setActiveTool({ name: event.call.name, detail: event.call.rawArguments.slice(0, 200), respond: null });
            break;
          case 'approval_required':
            setActiveTool({ name: event.call.name, detail: event.preview, respond: event.respond });
            setMode('approval');
            break;
          case 'tool_result':
            setActiveTool(null);
            push({
              kind: 'tool',
              name: event.name,
              summary: summarize(event.result),
              status:
                event.result.startsWith('Error:') ? 'error' : event.result.startsWith('The user denied') ? 'denied' : 'ok',
            });
            break;
          case 'usage':
            setTotals(event.totals);
            break;
          case 'done':
            if (event.reason === 'max_iterations') {
              push({ kind: 'info', text: `stopped: hit the ${config.maxIterations}-iteration limit` });
            } else if (event.reason === 'cancelled') {
              push({ kind: 'info', text: 'cancelled' });
            } else if (event.reason === 'error') {
              push({ kind: 'info', text: `error: ${event.error}` });
            }
            break;
        }
      }

      setStreamText('');
      setActiveTool(null);
      setStatus(null); // a run that ends mid-retry must not leave a stale retry message
      abortRef.current = null;
      setMode('input');
    })();
  };

  const decide = (approved: boolean) => {
    setActiveTool((current) => {
      current?.respond?.(approved);
      return current ? { ...current, respond: null } : null;
    });
    setMode('working');
  };

  useInput(
    (_input, key) => {
      if (key.escape) abortRef.current?.abort();
    },
    { isActive: mode === 'working' },
  );

  // Ctrl+D at the prompt = EOF = quit, the universal terminal convention.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'd') exit();
    },
    { isActive: mode === 'input' },
  );

  return (
    <Box flexDirection="column">
      <Transcript key={generation} items={items} />
      {streamText ? <ItemView item={{ kind: 'assistant', text: streamText }} /> : null}
      {activeTool ? (
        <ToolCallCard
          name={activeTool.name}
          detail={activeTool.detail}
          awaitingApproval={mode === 'approval' && activeTool.respond !== null}
          onDecision={decide}
        />
      ) : null}
      <Box marginTop={1}>
        <InputBox active={mode === 'input'} onSubmit={submit} />
      </Box>
      <StatusBar model={provider.model} mode={mode} totals={totals} status={status} />
    </Box>
  );
}
