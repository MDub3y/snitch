# Snitch

A mini terminal coding agent in TypeScript (name inspired by the Golden Snitch from Harry Potter). You describe a task; Snitch plans, calls tools in a loop — reading and editing files, searching the repo, running shell commands — and reports back, with a human approval gate on anything that mutates your machine.

Lightweight by design (3 runtime dependencies), built in documented phases, and structured so the model, tools, and UI can each evolve independently.

## Highlights

- **Agent loop** — model → tool calls → results → model, until the task is done. Guards: iteration cap, context-budget trimming, Esc/Ctrl+C cancellation, graceful handling of denials, malformed arguments, and tool failures (all fed back to the model, never crashing the session).
- **8 tools**: `read_file`, `write_file`*, `edit_file`*, `list_dir`, `glob`, `grep`, `run_command`*, `todo_write` — the starred ones show a y/n approval card before executing.
- **Ink React TUI** — flicker-free transcript, live streaming output, tool approval cards, spinner + token/cost status bar, slash commands.
- **Headless mode** — the same loop scripted from the command line (`--headless`), with y/n prompts on stdin.
- **Provider abstraction** — raw `fetch` + a small SSE parser against OpenRouter's OpenAI-compatible API (no SDK). Retry-After-aware backoff for free-tier rate limits. A `--prompt-tools` adapter lets models *without* native tool calling drive the identical loop via fenced-JSON calls.
- **Windows-safe shell** — command timeouts and cancellation kill the whole process tree (`taskkill /T /F`), not just the parent.

Default model: `poolside/laguna-s-2.1:free` via [OpenRouter](https://openrouter.ai) — swappable per run (`--model`) or per session (`/model`).

## Architecture

```
src/
├── index.tsx      # CLI entry: --headless, --model, --prompt-tools
├── config.ts      # API key, model, budgets (.env / snitch.config.json / flags)
├── llm/           # LLMProvider contract, OpenRouter + SSE, retry, prompt-tools adapter
├── tools/         # tool contract + registry, fs / search / shell tools
├── agent/         # the loop (AgentEvent stream), history + trimming, system prompt
├── ui/            # Ink components: App, Transcript, ToolCallCard, InputBox, StatusBar
└── headless.ts    # readline-driven runner over the same AgentEvent stream
```

The loop is an async generator of `AgentEvent`s and knows nothing about rendering — the TUI and the headless runner are just two consumers of the same stream. Approvals work by suspending the generator on a promise until the user answers.

## Requirements

- Node.js ≥ 22
- A real terminal (Windows Terminal recommended on Windows — legacy conhost is flaky with raw input)
- An OpenRouter API key: set `SNITCH_API_KEY` or `OPENROUTER_API_KEY` (environment or `.env` file)

## Getting started

```sh
npm install
npm run dev        # run the TUI from source
npm test           # run the vitest suite (66 tests)
npm run build      # compile to dist/
npm link           # make the `snitch` command available globally
```

## Usage

```sh
snitch                                 # interactive TUI
snitch --headless "create hello.py and run it"   # one-shot task, y/n prompts on stdin
snitch --headless --yes "..."          # one-shot task, auto-approve tool calls (for scripts/pipes)
snitch --model poolside/laguna-s-2.1   # override the model for this run
snitch --prompt-tools                  # prompt-based tool calling for models without native support
```

Inside the TUI: type a task and press Enter. Tool calls that mutate anything show an approval card — press `y` to run or `n` to deny. `Esc` cancels a running task. While the agent is working you can keep typing: Enter queues the next message and it runs when the current task finishes.

Project instructions: if a `SNITCH.md` file exists in the working directory, its contents are injected into the system prompt at startup (and on `/clear`) — use it for project conventions, build commands, style rules, and anything else the agent should always know.

Slash commands: `/help`, `/clear` (reset conversation), `/model <id>` (switch model), `/exit`. Quitting also works the way any terminal tool does: type `exit`, `quit`, or `q`, or press `Ctrl+D` or `Ctrl+C`.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Objective, architecture, v1 toolset, key design decisions |
| [docs/PHASES.md](docs/PHASES.md) | Phase tracker: prerequisites, acceptance criteria, completion status |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Dated decision log with rationale |

## Project status

v1 complete: all 6 development phases are implemented and tested (see [docs/PHASES.md](docs/PHASES.md)). Verified live against `poolside/laguna-s-2.1:free` on 2026-09-03: headless streaming, the tool-calling E2E, and the `--prompt-tools` fallback all pass; free-tier rate limits are absorbed by the retry backoff. The interactive TUI session is the one check that needs a human at a real terminal.
