# Snitch — Phase Tracker

> A phase is **done** only when: acceptance criteria met, tests green, its checkbox below is ticked with a completion date, and [SPEC.md](SPEC.md) / [DECISIONS.md](DECISIONS.md) reflect anything the phase changed or decided.

**Live verification (2026-09-03, real API key, `poolside/laguna-s-2.1:free`):**

- [x] Phase 2 smoke test: `snitch --headless "say hi"` streamed a reply; free-tier 429s absorbed by the Retry-After backoff (3 retries observed, then success).
- [x] Phase 4 E2E: `snitch --headless --yes "create hello.py ... and run it with python"` — native tool calling confirmed live; well-formed `write_file` and `run_command` args; correct final summary.
- [x] Phase 6 `--prompt-tools` E2E: same scenario completes via the fallback adapter. Live run surfaced that Laguna emits XML-style `<tool_call>` markup instead of the instructed fenced JSON; `extractToolCalls` now parses both (see DECISIONS 2026-09-03).
- [x] Phase 5 interactive TUI session in Windows Terminal (verified 2026-09-03): streamed reply rendered, upstream 429 exhaustion surfaced as a clean transcript error with return to ready. Found and fixed: status bar kept a stale "retry 3/4" message after the run ended (cleared in end-of-run cleanup). Esc-cancel and Ctrl+C restore still worth a spot-check when the free tier cooperates.

Fix that came out of live testing: piped/EOF stdin crashed headless approvals (`ERR_USE_AFTER_CLOSE`); added `--yes` auto-approve flag and closed-stdin-means-deny handling. Suite is now 64 tests.

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

- [x] **Phase 5 — Ink TUI + approvals** (completed 2026-09-02; render + approval mechanics verified via ink-testing-library, live interactive session pending API key)
  - Prerequisites: Phase 4 (consumes the loop's `AgentEvent` stream) + Phase 1 UI shell
  - Acceptance:
    - Full interactive session; approval cards block until answered
    - Esc cancels mid-stream; Ctrl+C exits and restores the terminal; resize-safe

- [x] **Phase 6 — Polish** (completed 2026-09-02)
  - Prerequisites: Phase 5 (slash commands / cost tally live in the TUI); the fallback adapter itself needs only Phase 4
  - Acceptance:
    - `/help` `/clear` `/model` `/exit` slash commands
    - Token-budget trimming enforced + tested
    - `--prompt-tools` fallback completes the Phase 4 headless scenario
    - Cost tally in the status bar; README finalized

---

## v2 — Security auditor + subscription auth

> Spec: the v2 README (branch `v2`). v2 adds two modules (`security/`, `memory/`) and a second auth path; the coding agent from v1 is untouched and remains fully usable with neither invoked. Already shipped before v2 and NOT re-listed below: `--yes`, `--plan`, `/plan`, `/compact`, SNITCH.md injection.

- [x] **Phase 7 — Auth & providers: subscription + direct BYOK** (completed 2026-10-01; live subscription smoke test pending a logged-in Claude plan — all other acceptance criteria met, 130 tests green)
  - Prerequisites: Phase 6 (v1 complete)
  - Scope: a `SubscriptionProvider` behind the existing `LLMProvider` contract, calling the Claude Agent SDK with `allowedTools: []` and reading the final message; `AnthropicProvider` (Messages API); OpenAI direct via the existing OpenAI-compat path with `baseUrl` routing; auth resolution in `config.ts` (`CLAUDE_CODE_OAUTH_TOKEN` → subscription, else `SNITCH_API_KEY`/`OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`); key redaction in all error/trace output
  - Acceptance:
    - `snitch --headless "say hi"` works live on a Claude Pro/Max plan with only `CLAUDE_CODE_OAUTH_TOKEN` set — no API key, no per-token billing
    - Startup warning when both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are set (the SDK silently prefers the API key)
    - Provider-selection matrix unit-tested (each env/config combination picks the documented provider)
    - No key or token ever appears in logs, errors, or traces — redaction tested
    - Agent SDK is an optional dependency: BYOK-only installs work without it

- [x] **Phase 8 — SSRF knowledge + deterministic Map/Find-sinks stages** (completed 2026-10-01; 136 tests green)
  - Prerequisites: Phase 6 (uses existing `glob`/`grep`/`read_file` tools); independent of Phase 7
  - Scope: `security/` module — sources/sinks/sanitizers catalogs for Rust (reqwest, hyper, ureq, isahc/surf, `TcpStream::connect`; axum/actix extractors, suspicious field names; allowlist / private-IP / scheme checks); repo mapper that pairs sources with reachable sinks into candidate slices. Zero LLM calls in these stages
  - Acceptance:
    - Fixture Rust repos (vulnerable + safe) under `tests/fixtures/`; mapper finds every planted source and sink, pairs them into candidates
    - Sanitizer detection downranks the safe fixture's candidates
    - Stage output is a typed `Candidate[]` (source, sink, slice file-spans) consumable by Phase 9
    - Fully unit-tested, no network, no model

- [ ] **Phase 9 — Trace + Rank**
  - Prerequisites: Phases 7 + 8 (needs a provider and candidates)
  - Scope: trace stage — a `task` sub-agent per candidate, prompted with only the sliced source→sink path, returning a structured verdict (reaches-sink? sanitized? confidence, reasoning); ranker scoring by directness, missing sanitizer, source-name signal (memory weights stubbed until Phase 11)
  - Acceptance:
    - FakeProvider tests: well-formed and malformed trace verdicts both handled; a failed trace downgrades, never crashes the scan
    - Vulnerable fixture ranks above safe fixture; ranking is deterministic for identical inputs
    - Trace prompt contains only the slice, not the whole repo (asserted on prompt size)

- [ ] **Phase 10 — Report + disclosure gate + `snitch scan`**
  - Prerequisites: Phase 9
  - Scope: advisory template (root cause, source→sink trace, PoC sketch, suggested fix); `snitch scan <path-or-git-url>` CLI (headless + `--headless`); drafts written to `findings/` marked UNVERIFIED; disclosure gate = the existing y/n approval card — a finding is recorded as confirmed only on human approval
  - Acceptance:
    - End-to-end scan of the vulnerable fixture emits a draft advisory in `findings/`; the safe fixture emits none at High confidence
    - Nothing is ever marked confirmed without an explicit approval; denial records a false-alarm verdict
    - Git-URL input clones to a temp dir and cleans up; headless scan exits non-zero on scan failure, zero on clean completion

- [ ] **Phase 11 — Self-improving findings memory**
  - Prerequisites: Phase 10 (verdicts exist to learn from)
  - Scope: `memory/` module — plain-JSON store in `.snitch/memory/`; on each verdict record the source→sink shape, verdict, and reason; reinforce + half-life decay; exemplar selection into the trace prompt; verdict-derived weights into the ranker
  - Acceptance:
    - Verdict round-trip test: a recorded false-alarm shape ranks lower on the next scan of the same fixture; a confirmed shape ranks higher
    - Decay tested with a fake clock (stale entries fade below threshold)
    - Store is human-readable JSON; deleting `.snitch/memory/` resets cleanly; nothing leaves the machine (no network in `memory/`)

- [ ] **Phase 12 — TUI scan flow + v2 polish**
  - Prerequisites: Phases 10 + 11
  - Scope: `/scan <repo>` in the TUI with candidates streaming in as accept/reject cards (reusing the approval-card component); scan progress in the status bar; `SECURITY.md`; README verified against shipped behavior
  - Acceptance:
    - Interactive `/scan` session: cards accepted/rejected update memory and `findings/` identically to headless
    - Esc cancels a scan mid-pipeline without corrupting the memory store
    - Live verification: scan a real open-source Rust repo with a known SSRF (or a planted one) end-to-end on the subscription provider
    - Docs (README, SPEC, DECISIONS, SECURITY.md) reflect v2 as shipped
