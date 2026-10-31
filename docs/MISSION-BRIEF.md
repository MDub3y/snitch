# Snitch — Mission Brief

_Last updated: 2026-10-31. Paste this whole doc as your opening instruction. It is self-contained; the fuller rationale lives in [SECURITY-PLAN.md](SECURITY-PLAN.md) in the same Canvas, but you can execute from this alone._

## Your mission

You are continuing **Snitch**, a CLI being turned from a general terminal coding agent into a **Rust-first offensive-security scanner** that reasons about code like an attacker and ranks findings by **what is actually reachable and exploitable** — not raw pattern matches. The engine (Phase 0 + the static core of Phase 1) is built, tested, and merged into an open PR. Your job is to take it from "works on a scripted test" to "measurably finds real vulnerabilities," then extend it through the remaining phases.

**Work in priority order through the Missions section below. Start with Mission 1 — do not skip it.** Mission 1 is the gate: it builds the measurement harness that tells every later mission whether a change actually helped. Without it you will be tuning blind.

**Before each mission:** read the named files, keep the existing test suite green, and add tests for what you build. **After each mission:** open (or update) a PR with the acceptance evidence, and report the numbers.

## Operating rules (read these — this is offensive-security tooling)

- **Owner's code only.** Snitch analyzes code the operator points it at and has authorised. v1 is **static** — never run it against live or third-party systems, and never add a live-target mode without an explicit, scoped, authorization-gated design.
- **No weaponization.** The goal is proving exploitability in *your* code within *your* dev cycle. Do not generate evasion or payloads aimed at external systems.
- **Live runs cost money.** Every model-backed scan spends tokens. Benchmarks run many scans — get a budget/approval before large eval runs, fix the model + settings for reproducibility, and report spend.
- **Additive only.** The agent loop (`src/agent/loop.ts`) is deliberately untouched. Extend via the `security/` module and new tools; don't refactor the loop to fit a feature.

## Current state

| | Status |
|---|---|
| Branch / PR | `runtime/mvwp7ino-2bd7f047` → **PR #1 open** against `main` (`https://github.com/MDub3y/snitch/pull/1`) |
| Build (`npm run build`) | clean |
| Typecheck (`npx tsc --noEmit`) | clean |
| Tests (`npm test`) | **135 pass, 1 fail** |
| The 1 failure | `tests/tools-shell.test.ts` "prefers Git Bash on Windows" — **pre-existing**, env-dependent (needs Windows env vars), fails identically on `origin/main`. Not ours; leave it. |
| Live model-backed scan | **Not yet run** — no credential was available. This is Mission 1's first step. |

## What already exists

### Security scan engine (Phase 0 + static Phase 1)
- `src/security/findings.ts` — `Finding` type + exploitability scoring / ranking / dedup / threshold / summary (pure).
- `src/security/taxonomy.ts` — Rust threat taxonomy as structured data; Phase-1 categories (panic/DoS, command/path/SQL injection, SSRF) flagged `[PRIORITY]`.
- `src/tools/security.ts` — `emit_finding` tool (read-only, closure-collected via `FindingsCollector`, validated).
- `src/security/prompts.ts` — the attacker-intuition scan system prompt.
- `src/security/report/sarif.ts` — SARIF 2.1.0 (GitHub code-scanning). `report/markdown.ts` — ranked human report.
- `src/security/scan.ts` — orchestrator: read-only registry + `emit_finding`, full-repo or `--diff` scope, writes report + SARIF, sets CI exit code.
- `src/index.tsx` — `snitch scan [path] [--diff] [--sarif] [--report] [--fail-on] [--provider] [--model]`.
- `docs/CI.md` — CI integration (GitHub Actions workflow inlined as a copy-in block; not committed under `.github/` because the push token lacks `workflow` scope).
- `tests/fixtures/rust-vuln/` — a seeded crate with one reachable Phase-1 vuln each (panic/DoS, path-traversal, command-injection, SQL-injection). **Known ground truth — use it for the first live run.**

### AI backend — runs on the operator's own Claude subscription (no API key)
- `src/llm/anthropic.ts` — `AnthropicProvider` on `@anthropic-ai/sdk`. Manual streaming (Snitch owns its loop — **do not** switch to the SDK tool-runner). Translates OpenAI-shaped history ⇄ Anthropic Messages (tool_use / tool_result). Zero-arg client resolves creds: `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ant auth login`/Claude Code OAuth profile.
- `src/llm/factory.ts` — `createProvider(config)` picks anthropic vs openrouter; wired into scan, headless, TUI.
- `src/config.ts` — `provider` chosen by `--provider`, config, or auto-detect (Anthropic creds in env, or a `claude-*` model). Anthropic default model `claude-opus-5-5`.

## How to run

```sh
npm install && npm run build && npm test

# On a Claude subscription (no key needed if signed in via `ant auth login`):
node dist/index.js scan path/to/rust/repo --provider anthropic --sarif out.sarif --fail-on high

# Or OpenRouter:
SNITCH_API_KEY=... node dist/index.js scan . --fail-on high

# PR/CI mode (only changed Rust files):
node dist/index.js scan . --diff origin/main --sarif snitch.sarif
```
Exit code: `0` = nothing met `--fail-on`; `1` = gate tripped.

## Architecture gotchas (don't relearn these the hard way)

- **Scan = read-only loop.** `scan.ts` builds the default registry + `emit_finding`, then `registry.readOnlyView()` drops every approval-gated tool (write/edit/run_command/task). The scan physically cannot mutate the target — same machinery as plan mode.
- **`emit_finding` captures `this` as `collector`.** The registry calls `tool.execute(...)`, so `this` would be the tool literal; the getter captures the collector. Don't "simplify" it away.
- **`runScan` is test-injectable:** `providerOverride` (an `LLMProvider`) and `quiet` keep the end-to-end test offline and silent. The CLI `provider` (a `ProviderName` string) is a *different* field — don't confuse them.
- **Anthropic provider streams text live, then emits tool_calls + usage from `finalMessage()`** — mirrors the OpenRouter provider.
- Pure modules (findings, taxonomy, reports, translation) are unit-tested with no network; only a real end-to-end scan needs a model.

---

## Missions

Each mission is independently shippable. Fuller design for each is in `SECURITY-PLAN.md` §7a; the acceptance bar is restated here.

### Mission 1 — Make quality measurable *(do this first)*
**Goal:** prove the scanner works on real code, and stand up a reproducible benchmark so later missions have a signal.
1. **Live smoke test.** With a credential available, scan `tests/fixtures/rust-vuln/`. Confirm the agent surfaces all four seeded Phase-1 issues with `reachable: true`, ranked above noise, and that the SARIF is well-formed.
2. **Curate the eval corpus (§8c).** ~15–30 real crates/commits, each anchored to a verified **RustSec advisory** (source of truth: `github.com/rustsec/advisory-db`). Span the taxonomy, weighted to Phase-1 categories. **Verify every advisory id + fixed version before adding it — do not invent ids.**
3. **Build the pre-fix-checkout harness (§8b)** in `eval/` (a script, not part of unit CI): for each entry, `git checkout` the last vulnerable commit → scan → score against the advisory label (true positive); then the patched commit → it must *not* re-flag (false-positive check). Emit precision / recall / ranking per category. Run model-fixed and N times for variance.

**Acceptance:** the fixture smoke test passes; the harness runs end-to-end on the corpus and prints a baseline precision/recall/ranking report per category. Report the numbers and the token spend.

### Mission 2 — Finish Phase 1 (static triage depth)
Entry-point discovery helper (`src/security/entrypoints.ts`: bins/main, `#[no_mangle]`/`extern "C"`, web-route macros, `pub` API, `Deserialize` request bodies) feeding the scan so reachability is anchored, not guessed; plus scan-depth controls (`--max-files`, risk-ordering) for large repos.
**Acceptance:** fixture issues still all found; a real mid-size crate scans without hitting the iteration cap or crashing; corpus recall does not regress.

### Mission 3 — Phase 2: dependency + RustSec advisory layer (reachability-gated)
Parse `advisory-db` (`src/security/advisories.ts`, pure); read the dependency graph via a new read-only `cargo_metadata` tool; match versions to advisories; then gate by reachability (is the vulnerable API actually called from an entry point?). Emit `dependency` findings with `advisoryRefs`.
**Acceptance:** advisory hits split correctly into reachable vs. unreachable on corpus repos; a repo that merely lists an unused vulnerable crate yields no reachable finding; graceful degradation when no toolchain is present.

### Mission 4 — Phase 3: reachability + scoring calibration
Enforce explicit source→sink traces (`dataFlow`); calibrate the weights in `findings.ts` against the corpus so labeled-real outranks labeled-noise; publish precision/recall/ranking. Hold out a slice to avoid overfitting.
**Acceptance:** measurable improvement over the Mission 1 baseline, reported with variance.

### Mission 5 — Phase 4: CI hardening (cross-run baselining)
`--baseline snitch-baseline.json` with a content-hashed fingerprint (survives line shifts) so the gate fails only on *newly introduced* risk; validate the `docs/CI.md` GitHub Actions flow end-to-end (SARIF ingests, annotations land on changed lines).
**Acceptance:** re-scan of unchanged code with an up-to-date baseline reports zero new findings and exits 0; a new vuln in a PR trips the gate; an unrelated line-shift does not resurface a baselined finding.

### Mission 6 — Phase 5 (stretch): sandboxed proof-of-exploit
Opt-in (`--prove`) sandboxed execution of a generated Rust test to **confirm** a candidate PoC, against the operator's own code only, inside strict isolation (container, resource + network limits). Add a `verification` field (`unverified` | `confirmed` | `refuted`) to `Finding`.
**Acceptance:** for a subset of corpus findings, a generated PoC runs in the sandbox, fails on the vulnerable commit, and passes on the patched one. Inconclusive is always `unverified`, never a false `confirmed`. The sandbox is the critical control — default off.

---

## Standing decisions
- Keep the name **Snitch**; CI target is **GitHub Actions + SARIF**; Phase-1 priority is **panic/DoS + injection**; backend supports the operator's **Claude subscription** (no key).
- **Open:** rebrand the top-level `README.md` now or after Mission 1 validates live. Your call once the scanner is proven on real code.

## Read-first order
`src/agent/loop.ts` (loop, unchanged) → `src/security/scan.ts` (orchestrator) → `src/security/taxonomy.ts` + `src/security/prompts.ts` (what it hunts, how) → `src/llm/factory.ts` + `src/llm/anthropic.ts` (provider). Tests: `tests/security-*.test.ts`, `tests/anthropic.test.ts`, `tests/provider-select.test.ts`. Full plan: `SECURITY-PLAN.md`.
