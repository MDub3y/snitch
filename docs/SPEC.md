# Snitch — Specification

> Living document: updated at every phase boundary. See [PHASES.md](PHASES.md) for progress and [DECISIONS.md](DECISIONS.md) for the decision log.

## Objective

A lightweight terminal coding agent in TypeScript: the user types a task, the model plans and calls tools (read/write/edit files, search, run shell commands) in a loop until the task is done, with a human approval gate on anything that mutates the machine. Built in phases, designed so the model/provider, tools, and UI can each evolve independently.

## Model & provider

- Default model: `poolside/laguna-s-2.1:free` via OpenRouter (OpenAI-compatible chat completions).
  - Supports native tool calling (`tools` / `tool_choice`); 1M context, 131k max output.
  - Does **not** support `response_format` (no enforced JSON) — relevant to the prompt-based fallback only.
  - Paid slug `poolside/laguna-s-2.1` ($0.09/M in, $0.18/M out) available if free-tier rate limits bite.
- OpenRouter streams tool calls over SSE as `tool_calls` deltas with `finish_reason: "tool_calls"`; tool results return as `role: "tool"` messages keyed by `tool_call_id`.
- Config: `SNITCH_API_KEY` (falls back to `OPENROUTER_API_KEY`), `.env` via `process.loadEnvFile()`, optional `snitch.config.json`, `--model` flag override.

## Architecture

```
src/
├── index.tsx        # entry: flags (--model, --headless, --prompt-tools), boot
├── config.ts        # key/model/config resolution
├── llm/    types.ts · openrouter.ts · retry.ts · promptTools.ts
├── tools/  types.ts · registry.ts · fs.ts · search.ts · shell.ts
├── agent/  loop.ts · history.ts · prompts.ts
├── ui/     App.tsx · Transcript.tsx · MessageView.tsx · ToolCallCard.tsx · InputBox.tsx · StatusBar.tsx
├── headless.ts      # readline-driven runner (testing + piping)
└── util/   errors.ts · tokens.ts
tests/               # vitest: per-tool, SSE fixtures, FakeProvider loop tests
```

### Key design decisions

1. **No OpenAI SDK** — raw `fetch` + a small SSE parser. Runtime deps are exactly `ink`, `react`, `tinyglobby`. Build is plain `tsc`; ESM-only (`"type": "module"`, NodeNext, `.js` extensions on relative imports).
2. **UI-agnostic agent loop** — the loop is an async generator of `AgentEvent`s consumed identically by the headless runner and the Ink TUI.
3. **Approval = suspended promise** — the loop emits `approval_required { call, preview, respond(bool) }` and waits; denial becomes a tool-result string ("User denied execution") fed back to the model.
4. **Provider abstraction with a fallback seam** — `LLMProvider { capabilities: { nativeTools, streaming }, chat(): AsyncIterable<StreamEvent> }`. Native tool calling is primary; a `PromptToolAdapter` (Phase 6) wraps any provider, injecting tool docs into the system prompt and leniently parsing fenced-JSON tool calls into the same `ToolCallRequest` shape.
5. **Context trimming hook** — `History.toMessages(tokenBudget)`: chars/4 estimate, drop oldest complete exchange pairs (never the system prompt, never orphan a tool_call from its result), single truncation marker. ~200k-token default budget (a cost cap more than a context cap, given 1M context).
6. **Windows-safe shell** — `run_command` uses `spawn(cmd, { shell: true })`; timeout/cancel kills the process **tree** via `taskkill /PID <pid> /T /F`. Grep is pure TS (walk + regex) — no ripgrep dependency.

### TUI layout (Phase 5)

`<Static>` transcript (past messages + resolved tool cards, flicker-free) → live streaming tail → active ToolCallCard `[y]/[n]` → InputBox → StatusBar (model, spinner, token/cost tally). One app-level mode (`input | thinking | streaming | approval`) decides whose `useInput` is live; Esc triggers an `AbortController`.

## v1 Toolset

| Tool | Params | Approval |
|---|---|---|
| `read_file` | `path`, `offset?`, `limit?` (default 2000 lines, numbered output) | No |
| `write_file` | `path`, `content` (mkdir parents; diff preview in approval card) | **Yes** |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?` (error if not found/ambiguous) | **Yes** |
| `list_dir` | `path?` (entries + type/size) | No |
| `glob` | `pattern`, `path?` (tinyglobby; ignores node_modules/.git; mtime-sorted; ~200 cap) | No |
| `grep` | `pattern`, `path?`, `glob?`, `max_results?` (pure TS, `file:line:` output) | No |
| `run_command` | `command`, `cwd?`, `timeout_ms?` (60s default; exit code + 30KB-capped output) | **Yes** |

No `finish` tool: with native tool calling, `finish_reason: "stop"` ends the turn; the prompt-fallback adapter treats "no tool-call block parsed" as done. Deferred to later versions: `fetch_url`, `multi_edit`, todo tracking.

Registry pattern: `Tool = { name, description, paramsSchema (JSON Schema), requiresApproval, execute(args, ctx) }`, serialized to the OpenAI `tools` wire format by `tools/registry.ts`.

## Error handling

- API errors / 429s: Retry-After-aware exponential backoff with visible retry status.
- Tool execution errors are fed back to the model as tool results, not thrown at the user.
- Malformed tool-call args: forgiving parse; on failure the parse error goes back as the tool result.
- Max-iterations guard (default 24) on the agent loop; Esc/Ctrl+C cancellation via `AbortController`.
