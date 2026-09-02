# Snitch — Decision Log

> Newest first. Each entry: what was decided, why, and what was rejected.

## 2026-09-02 — Ink TUI from day one

**Decided**: Build the UI with Ink (React TUI) starting in Phase 1, rather than a plain readline REPL.
**Why**: Richer UX (streaming output, tool-approval cards, status bar) is a core part of the product; proving the Ink/ESM toolchain early de-risks it.
**Rejected**: Plain readline REPL (kept only as the `--headless` runner for testing/piping); "minimal now, Ink later" migration.

## 2026-09-02 — Approval gate on mutating tools

**Decided**: `write_file`, `edit_file`, and `run_command` prompt y/n before executing; denial is returned to the model as a tool result so the conversation continues.
**Why**: Standard agent safety model — the model can propose anything, the human owns execution.
**Rejected**: Unrestricted execution; excluding shell from v1.

## 2026-09-02 — Provider abstraction over direct OpenRouter calls

**Decided**: Thin `LLMProvider` interface with an OpenRouter implementation; model/key from config. Native tool calling primary, with a `PromptToolAdapter` fallback seam for models without it.
**Why**: "Future optimization" is an explicit project goal — swapping models/providers must be trivial. Laguna-S-2.1 was verified to support native tool calling on OpenRouter, so the fallback is deferred to Phase 6.
**Rejected**: Hard-coding OpenRouter + model into the loop; adopting the OpenAI SDK (raw `fetch` + small SSE parser keeps deps to 3).

## 2026-09-02 — Headless-first core

**Decided**: The agent loop is an async generator of `AgentEvent`s, built and E2E-tested via a readline headless runner (Phases 2–4) before the full TUI consumes the same stream (Phase 5).
**Why**: Decouples loop correctness from TUI rendering; gives a scriptable/pipeable mode for free; keeps the loop UI-agnostic permanently.
**Rejected**: Building the loop directly inside Ink components.
