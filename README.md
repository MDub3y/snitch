# ⚡ Snitch

A mini terminal coding agent in TypeScript (name inspired by the Golden Snitch from Harry Potter). Lightweight by design, built in phases, and structured for future optimization.

- **LLM**: `poolside/laguna-s-2.1:free` via [OpenRouter](https://openrouter.ai) (swappable — see the provider abstraction in [docs/SPEC.md](docs/SPEC.md))
- **UI**: [Ink](https://github.com/vadimdemedes/ink) React TUI
- **Safety**: file writes/edits and shell commands require y/n approval before executing

## Requirements

- Node.js ≥ 22
- A real terminal (Windows Terminal recommended on Windows — legacy conhost is flaky with raw input)
- An OpenRouter API key (from Phase 2 onward): set `SNITCH_API_KEY` or `OPENROUTER_API_KEY`

## Getting started

```sh
npm install
npm run dev        # run the TUI from source
npm test           # run the vitest suite
npm run build      # compile to dist/
npm link           # make the `snitch` command available globally
```

## Documentation

| Doc | What's in it |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Objective, architecture, v1 toolset, key design decisions |
| [docs/PHASES.md](docs/PHASES.md) | Phase tracker: prerequisites, acceptance criteria, completion status |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Dated decision log with rationale |

## Project status

Under active development — see [docs/PHASES.md](docs/PHASES.md) for what's done and what's next.
