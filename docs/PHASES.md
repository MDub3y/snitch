# Snitch — Phase Tracker

> A phase is **done** only when: acceptance criteria met, tests green, its checkbox below is ticked with a completion date, and [SPEC.md](SPEC.md) / [DECISIONS.md](DECISIONS.md) reflect anything the phase changed or decided.

- [x] **Phase 1 — Scaffold + Ink hello world + docs skeleton** (completed 2026-09-02)
  - Prerequisites: none (empty repo; Node ≥ 22 installed)
  - Acceptance:
    - `npm run dev` renders the TUI in Windows Terminal; keys echo; clean exit on `q`/Ctrl+C
    - `npm run build` (tsc) succeeds; `npm link` gives a working `snitch` command
    - vitest suite green
    - `README.md` + `docs/` (SPEC, PHASES, DECISIONS) created; git repo initialized

- [x] **Phase 2 — Provider layer + config** (completed 2026-09-02; live smoke test pending API key)
  - Prerequisites: Phase 1 (ESM/tsc toolchain, `snitch` bin working)
  - Acceptance:
    - `snitch --headless "say hi"` streams a Laguna reply (live run needs the API key)
    - SSE parser unit tests: split-chunk and tool-call-delta fixtures
    - 429 Retry-After backoff tested; bad/missing key produces a clear error message

- [x] **Phase 3 — Tool registry + 7 tools** (completed 2026-09-02)
  - Prerequisites: Phase 1 only (independent of Phase 2 — may proceed in parallel with it)
  - Acceptance:
    - Per-tool vitest in temp dirs: edit ambiguity, run_command timeout tree-kill, binary-file skip
    - Snapshot test of the serialized OpenAI `tools` payload

- [x] **Phase 4 — Agent loop, headless E2E** (completed 2026-09-02; live E2E pending API key)
  - Prerequisites: Phases 2 + 3 (provider `StreamEvent`s + tool registry)
  - Acceptance:
    - `snitch --headless "create hello.py and run it"` works end-to-end with y/n prompts
    - Denial handled gracefully (fed back to model, conversation continues)
    - FakeProvider tests: max-iterations guard (default 24), tool-error-as-result, cancellation

- [ ] **Phase 5 — Ink TUI + approvals**
  - Prerequisites: Phase 4 (consumes the loop's `AgentEvent` stream) + Phase 1 UI shell
  - Acceptance:
    - Full interactive session; approval cards block until answered
    - Esc cancels mid-stream; Ctrl+C exits and restores the terminal; resize-safe

- [ ] **Phase 6 — Polish**
  - Prerequisites: Phase 5 (slash commands / cost tally live in the TUI); the fallback adapter itself needs only Phase 4
  - Acceptance:
    - `/help` `/clear` `/model` `/exit` slash commands
    - Token-budget trimming enforced + tested
    - `--prompt-tools` fallback completes the Phase 4 headless scenario
    - Cost tally in the status bar; README finalized
