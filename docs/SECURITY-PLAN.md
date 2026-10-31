# Snitch — Offensive Security Agent (Rust-first)

**Pivot:** from a general terminal coding agent into a CLI that works offensive security *into the development cycle* — continuously reviewing code and infrastructure with attacker intuition to **prove what's actually exploitable**, not just flag suspicious patterns. Deep focus on **Rust** repositories, an underserved niche relative to the C/C++/web-heavy tooling market.

> The name fits the mission: a *snitch* reports wrongdoing. Here it snitches on your own vulnerabilities before an attacker finds them.

---

## 1. Positioning & the gap we're filling

| Existing tooling | What it does | Where it falls short (our wedge) |
|---|---|---|
| `cargo-audit`, `cargo-deny` | Match dependencies against RustSec advisory DB | Pure version matching. No reachability — flags vulns in code you never call. No exploitability reasoning. |
| `clippy`, `rust-analyzer` lints | Correctness/style lints | Not security-oriented; no threat model; huge false-positive noise if repurposed. |
| Semgrep / CodeQL | Pattern & dataflow rules | Rust support is thin vs. C/JS/Python; rules are static, no "attacker intuition," no proof. |
| Snyk / commercial SAST | Broad SAST + SCA | Rust is a second-class citizen; opaque; expensive; still pattern-first. |

**Our wedge:** an LLM agent that *reads and reasons about the code like an attacker* — tracing whether a flagged weakness is reachable from a real entry point, what an attacker controls, and whether it's genuinely exploitable — and that treats Rust's specific failure modes as first-class. Agentic reasoning + sandboxed proof is the thing pattern-matchers structurally cannot do.

---

## 2. Scope for v1

**Confirmed 2026-10-31:**

- **First capability:** Rust vulnerability triage — scan a repo, reason about reachable/exploitable issues, rank by exploitability with evidence. ✅
- **Codebase treatment:** extend in place via a new `snitch scan` subcommand that coexists with the generic agent, reusing the loop/tools/provider. ✅
- **Analysis mode:** **static-only** for v1 (read + reason + produce candidate PoCs/tests), with the architecture laid out so **sandboxed PoC execution** drops in as a later phase. No live-target scanning in v1. ✅
- **Language coverage:** **Rust deep, others shallow** — invest in Rust-specific analysis; keep language-agnostic reasoning so mixed repos aren't useless. ✅
- **Name:** keep **Snitch**. ✅
- **CI/output target:** **GitHub Actions + SARIF** (code-scanning), with exit-code gating. ✅
- **Phase-1 category priority:** **panic/DoS + injection** first. ✅
- **AI backend:** users can run Snitch on **their own Claude subscription** (no API key). An Anthropic provider via the official SDK resolves credentials itself — API key, auth token, or a Claude Code / `ant auth login` OAuth profile. OpenRouter stays as the alternative backend. ✅

**In scope (v1):** repo scanning, Rust threat taxonomy, reachability reasoning, dependency+advisory layer, structured findings with exploitability scores, diff/PR mode, SARIF + Markdown output.

**Out of scope (v1):** executing exploits against live/remote targets; network attack tooling; automated remediation PRs (later); non-Rust deep analysis; evasion/offensive payload generation for use against third parties.

---

## 3. Rust threat-model taxonomy (the heart of it)

What the scanner actually hunts for, Rust-specific where it counts:

**Memory & `unsafe`**
- `unsafe` blocks: raw pointer deref, `slice::from_raw_parts` with attacker-influenced len/ptr, `get_unchecked`, uninitialized memory (`MaybeUninit` misuse), `mem::transmute`, `mem::uninitialized`.
- FFI boundaries: C strings without NUL handling, lifetime/ownership violations across `extern`, `#[no_mangle]` surfaces.
- Soundness holes: `Send`/`Sync` manually (and wrongly) implemented; data races behind `unsafe`.

**Panics & DoS**
- `unwrap()`/`expect()`/`panic!`/`unreachable!`/indexing/`unwrap_or`-free arithmetic on attacker-controlled input reachable from a request handler → remote DoS.
- Unbounded allocation/recursion from untrusted length/size fields; `Vec::with_capacity(attacker_n)`.
- Integer overflow in release mode (wraps silently) feeding allocation, indexing, or auth/length checks.

**Injection & untrusted data**
- `std::process::Command` built from user input (command/arg injection), shell invocation.
- Path traversal (`../`) into `fs` ops; `Path::join` with attacker data.
- SQL built by string concatenation (sqlx raw / diesel `sql_query`); SSRF in `reqwest`/`hyper` clients.
- Deserialization of untrusted data (`serde` into types with surprising `Deserialize`, `bincode`, `rmp`, type-confusion, zip/decompression bombs).

**Web/app logic (axum / actix-web / rocket / warp)**
- Missing authn/authz on handlers; IDOR; broken access control.
- Secrets in code/logs; weak crypto (`md5`, `sha1`, ECB, hardcoded keys/IVs, `rand` instead of `rand::rngs::OsRng` for tokens).
- Missing TLS verification; CORS misconfig; JWT/signature verification skipped.

**Supply chain / dependencies**
- RustSec advisories on dependencies, **gated by reachability** (is the vulnerable API actually called on a path from an entry point?).
- Unmaintained crates, `build.rs` doing network/exec, `[patch]`/git deps pulling untrusted code.

Each category maps to a rule/prompt module and, ideally, to real ground-truth examples from the corpus (§8).

---

## 4. Feature list

**Core scan engine**
- `snitch scan [path]` — full-repo security pass; `--diff <ref>` / PR mode for only newly-introduced risk.
- Entry-point discovery (bins, `main`, web handlers, `pub` API surface, FFI exports) to anchor reachability.
- Reachability reasoning: does untrusted data flow from an entry point to the sink?
- Exploitability scoring (see §6), not just severity.

**Rust intelligence**
- `unsafe`/FFI census and per-block risk assessment.
- Dependency + RustSec advisory layer with reachability gating (wraps `cargo audit` / RustSec advisory-db).
- Crate-feature awareness (a vuln may only apply under a feature flag that's enabled).

**Output & integration**
- Structured findings: JSON + **SARIF** (GitHub code-scanning compatible) + human Markdown report.
- Exit codes keyed to severity thresholds for CI gating.
- Dedup/baseline so CI only fails on *new* findings.
- Candidate PoC: a described attack path + a generated failing test / input (not executed in v1).

**Later phases**
- Sandboxed PoC execution to *confirm* exploitability.
- Suggested-fix / remediation diffs.
- Live authorized-target mode (scoped, authorization-gated).

---

## 5. Architecture — mapping to the existing codebase

The agent loop stays untouched. Everything is additive.

```
src/
├── index.tsx          # add `scan` subcommand dispatch
├── security/          # NEW
│   ├── scan.ts        # scan orchestrator: discover → loop → collect findings
│   ├── taxonomy.ts    # the Rust threat categories (§3) as structured knowledge
│   ├── findings.ts    # Finding type, scoring, dedup/baseline
│   ├── report/        # SARIF + Markdown emitters
│   └── prompts.ts     # attacker-intuition system prompt + per-category guidance
├── tools/
│   ├── security.ts    # NEW: cargo_audit, advisory_lookup, callgraph/reachability helpers, emit_finding
│   └── ...            # existing fs/search/shell/web reused as read-only
└── agent/loop.ts      # unchanged
```

- **Static mode = `registry.readOnlyView()` + security tools** — the plan-mode machinery already proves a read-only loop works; the scanner is that pattern with a findings-emitter instead of a plan.
- **`emit_finding` tool** — the model reports each finding as a structured record (file, line, category, reachability evidence, exploitability rationale, candidate PoC) instead of prose, so output is machine-usable.
- **Security system prompt** — a variant of `buildSystemPrompt` carrying the attacker persona + §3 taxonomy; repo-specific context via the existing `SNITCH.md` override mechanism.

---

## 6. Finding & exploitability model

```
Finding {
  id, category, file, line_range,
  entry_point,              // where attacker-controlled data originates
  data_flow,                // traced path source → sink
  severity,                 // impact if exploited (CVSS-ish)
  exploitability: {
    reachable: bool,        // is the sink on a real path from an entry point?
    attacker_control: enum, // none | partial | full over the trigger
    preconditions,          // what must hold (feature flag, auth state, config)
    confidence,             // model's calibrated confidence
  },
  evidence,                 // quoted code + reasoning
  candidate_poc,            // described attack / failing test (unexecuted in v1)
  advisory_refs,            // RustSec/CVE ids if dependency-related
}
```

Ranking = `f(severity, reachable, attacker_control, confidence)` so a reachable remote DoS outranks a theoretical `unsafe` in dead code. This "prove it's real" ranking is the core differentiator.

---

## 7. Development phases (incremental, each shippable & testable)

| Phase | Deliverable | Acceptance |
|---|---|---|
| **0 — Rebrand/scaffold** | `snitch scan` subcommand, `security/` module skeleton, security prompt, `emit_finding` tool, Finding type | `snitch scan .` runs the read-only loop and emits an (empty/stub) structured report |
| **1 — Static Rust triage** | Taxonomy §3 wired into prompts; entry-point discovery; Markdown + JSON report | Finds seeded issues in a small fixture crate; no crashes on a real repo |
| **2 — Dependency + advisory layer** | `cargo_audit` + RustSec advisory-db tools, reachability gating | Correctly separates reachable vs. unreachable advisory hits on corpus repos |
| **3 — Reachability & exploitability scoring** | Data-flow reasoning, scoring model §6, ranking | Measurable precision/recall on the eval corpus (§8); ranking puts real issues on top |
| **4 — CI/diff mode + SARIF** | `--diff`, baseline/dedup, SARIF output, exit codes | Runs in GitHub Actions, uploads to code-scanning, fails only on new findings |
| **5 — Sandboxed PoC (stretch)** | Isolated execution to confirm candidate PoCs | Confirms at least a subset of findings by running generated tests in a sandbox |

Each phase keeps the existing test suite green and adds its own tests.

### Build status (2026-10-31)

**Phase 0 + the static core of Phase 1 are implemented** (extend-in-place; agent loop untouched):

- `src/security/findings.ts` — Finding type + exploitability scoring, ranking, dedup, threshold, summary (pure).
- `src/security/taxonomy.ts` — the full §3 taxonomy as structured data; Phase-1 categories flagged `[PRIORITY]` and rendered first.
- `src/tools/security.ts` — `emit_finding` tool (read-only, closure-collected, validated).
- `src/security/prompts.ts` — the attacker-intuition scan system prompt.
- `src/security/report/{sarif,markdown}.ts` — SARIF 2.1.0 (GitHub code-scanning) + ranked Markdown.
- `src/security/scan.ts` — orchestrator: read-only registry + `emit_finding`, full-repo or `--diff` scope, writes report + SARIF, sets CI exit code.
- `src/index.tsx` — `snitch scan [path] [--diff] [--sarif] [--report] [--fail-on]`.
- CI: `docs/CI.md` — GitHub Actions workflow inlined to copy in (kept out of `.github/` so the push needs no `workflow` OAuth scope).
- Fixture: `tests/fixtures/rust-vuln/` — one reachable Phase-1 vuln each (panic/DoS, path-traversal, command-injection, SQL-injection).

**AI backend — use your own Claude subscription (no API key):**

- `src/llm/anthropic.ts` — `AnthropicProvider` implementing the existing `LLMProvider` streaming contract via the official `@anthropic-ai/sdk`. Snitch keeps its own agent loop (so no SDK tool-runner); the provider translates our OpenAI-shaped history ⇄ Anthropic Messages (tool_use / tool_result blocks) and streams events back. A zero-arg client resolves credentials itself: `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → an `ant auth login` / Claude Code OAuth profile — a subscriber needs no key.
- `src/llm/factory.ts` + `src/config.ts` — `provider: anthropic | openrouter`. Chosen by `--provider`, or config, or auto-detected (Anthropic creds in env, or a `claude-*` model requested). Default Anthropic model `claude-opus-5-5`; OpenRouter default unchanged. Wired through scan, headless, and the TUI.
- Default end-to-end validation can now run on a Claude subscription instead of an OpenRouter key.

**Tests:** 43 new unit tests (findings, emit_finding, taxonomy, SARIF, Markdown, end-to-end scan with a scripted provider, Anthropic translation + streaming, provider selection) — all green; full suite **130 pass**. *(One pre-existing Windows-shell test fails on Linux, unrelated — it depends on Windows env vars; confirmed failing identically on `origin/main`.)*

**Not yet done in Phase 1:** live end-to-end validation against a real model (needs a Claude subscription or an API key in this environment); deeper entry-point discovery heuristics; the curated real-repo corpus (§8c).

> **Note on phase order.** Because "CI target first" was chosen, the SARIF output, `--diff` scoping, and exit-code gating that the table parks in Phase 4 already landed in Phase 1. What remains of "Phase 4" is cross-run baselining and a live CI validation — folded into §7a below. The phases are a dependency order, not a strict calendar.

---

## 7a. Next phases — detailed design

Each phase is independently shippable, keeps the suite green, and adds its own tests. For every phase: **Goal → Deliverables → Design (how it fits the existing architecture) → Acceptance → Risks/open questions.**

### Phase 1 — remaining work (finish static Rust triage)

**Goal.** Close out Phase 1 so a single `snitch scan` on a real Rust repo produces trustworthy, well-ranked findings.

**Deliverables.**
- Live end-to-end validation against the fixture crate and 1–2 real repos (currently only validated with a scripted provider).
- Entry-point discovery helper so the agent reliably anchors reachability instead of guessing.
- Scan-depth controls for large repos (file budget, ordering by risk).

**Design.**
- **Entry-point map (`src/security/entrypoints.ts`, pure + a read-only tool).** Heuristically enumerate attack surface before the agent reasons: `fn main`, `[[bin]]`/`[[example]]` targets, `#[no_mangle]`/`extern "C"` exports, web-framework route macros (`#[get]`/`#[post]`, `Router::route`, `.service(`, `.route(`), `pub fn` in `lib.rs`, and `Deserialize` structs bound to request bodies. Feed the map into the scan message so the agent starts from "where untrusted data enters," which is the backbone of reachability.
- **Depth control.** `scan.ts` already lists files; add `--max-files` and risk-ordering (files containing taxonomy sink patterns first) so big repos don't blow the iteration cap silently. Surface a clear "scope truncated" note in the report when hit.

**Acceptance.** On `tests/fixtures/rust-vuln/` the four seeded Phase-1 issues are all surfaced, reachable=true, ranked above noise; a scan of a real mid-size crate completes without hitting the iteration cap or crashing.

**Risks.** Route/macro detection varies across frameworks — keep it best-effort and never let a missed entry point suppress a finding the agent reasons out directly.

---

### Phase 2 — dependency + RustSec advisory layer (reachability-gated)

**Goal.** Flag vulnerable dependencies, but only when the vulnerable API is actually reachable — the thing that separates Snitch from plain `cargo audit` version-matching.

**Deliverables.**
- A RustSec advisory lookup against the dependency tree.
- Reachability gating: for each advisory hit, decide whether the affected crate's vulnerable surface is called on a path from an entry point.
- `dependency`-category findings carrying `advisoryRefs` (already in the `Finding` schema).

**Design.**
- **Advisory source.** Vendor/clone `rustsec/advisory-db` (TOML per advisory: crate, patched/unaffected version ranges, category, informational flags). Parse with a small pure module `src/security/advisories.ts` (unit-testable offline against fixture TOML).
- **Dependency tree.** Prefer `cargo metadata --format-version 1` (resolved graph, no network) over parsing `Cargo.lock` by hand. New read-only tool `cargo_metadata` in `src/tools/security.ts` (it only reads, so it survives the read-only view and needs no approval). Match resolved `crate@version` against advisory ranges → candidate advisory hits.
- **Reachability gate.** For each candidate, the agent (a) locates call sites of the affected crate in the codebase (via existing `grep`/`read_file`) and (b) judges whether the advisory's specific vulnerable function/feature is on a reachable path. Reachable → `reachable: true` finding; otherwise `reachable: false` (kept, ranked low), matching the existing scoring model.
- **Feature awareness.** Honor `cargo metadata`'s resolved features — an advisory scoped to a feature that isn't enabled is informational.

**Acceptance.** On corpus repos, advisory hits are correctly split into reachable vs. unreachable; a repo that merely *lists* a vulnerable crate it never calls does not produce a reachable finding; `advisoryRefs` appear in SARIF/Markdown.

**Risks.** `cargo metadata` needs a toolchain present — degrade gracefully (fall back to `Cargo.lock` parse; skip the layer with a clear note if neither is available). Advisory-db schema drift — pin a vendored commit and parse defensively.

---

### Phase 3 — reachability & exploitability scoring (depth + calibration)

**Goal.** Make reachability reasoning deeper and the ranking measurably good, benchmarked on the eval corpus.

**Deliverables.**
- Structured data-flow reasoning (source → sink) captured in each finding's `dataFlow`.
- A tuned scoring/ranking model validated against labeled data.
- A reproducible precision/recall/ranking report per threat category.

**Design.**
- **Guided data-flow.** Extend the scan prompt + method to require, per candidate sink, an explicit backward trace to an entry point with the intermediate functions named. This already maps to the `entryPoint`/`dataFlow`/`preconditions` fields; Phase 3 enforces and scores their quality.
- **Scoring calibration.** The weights in `findings.ts` (`SEVERITY_WEIGHT`, `CONTROL_FACTOR`, `CONFIDENCE_FACTOR`, `UNREACHABLE_FACTOR`) are currently hand-set. Calibrate them against the corpus so that known-real issues outrank known-noise, and record the chosen weights with rationale. Keep the function pure and unit-tested.
- **Eval harness (`eval/` + a script, not part of unit CI).** Implements the "pre-fix checkout" methodology (§8b): for each corpus entry, `git checkout` the vulnerable commit, scan, score against the advisory label; then the patched commit for the false-positive check. Emits precision/recall/ranking per category. Runs as a separate, network+model benchmark.

**Acceptance.** Published precision/recall per category on the corpus; ranking places labeled-real issues above labeled-noise on a clear majority of corpus repos; a weight change can be shown to move the numbers.

**Risks.** LLM nondeterminism makes the benchmark noisy — run N times and report variance; fix the model/temperature for benchmark runs. Guard against overfitting weights to the corpus — hold out a slice.

---

### Phase 4 — CI hardening: cross-run baselining

**Goal.** Make the CI gate stable over time: fail only on *newly introduced* exploitable risk, not the repo's pre-existing backlog.

_(SARIF output, `--diff` PR scoping, and exit-code gating already shipped in Phase 1; this phase adds what they still need to be production CI.)_

**Deliverables.**
- A baseline file (`snitch-baseline.json`) of accepted/known findings.
- Dedup against the baseline so a PR scan reports only deltas.
- A documented, validated GitHub Actions run uploading SARIF to code-scanning.

**Design.**
- **Baseline.** `snitch scan --baseline snitch-baseline.json` suppresses findings already present (stable fingerprint: category + file + a content-hashed code snippet rather than a raw line number, so findings survive unrelated edits above them). `--update-baseline` rewrites it. Fingerprinting lives in `findings.ts` (pure, testable).
- **Delta gating.** Combine with the existing `--diff` and `--fail-on`: the gate trips only on new findings at/above the threshold.
- **CI validation.** Exercise `.github/workflows/snitch-scan.yml` end-to-end on a sample repo; confirm SARIF ingests and annotations land on changed lines.

**Acceptance.** Re-running a scan with an up-to-date baseline on unchanged code reports zero new findings and exits 0; introducing a new vuln in a PR trips the gate and annotates the line; a line-shift edit does not resurface a baselined finding.

**Risks.** Fingerprint stability vs. sensitivity — a too-loose fingerprint hides a genuinely new issue; a too-tight one re-reports on every edit. Tune against the corpus.

---

### Phase 5 — sandboxed proof-of-exploit (stretch)

**Goal.** Move from "described candidate PoC" to "confirmed exploitable" by executing a generated test against the user's own code in isolation.

**Deliverables.**
- A sandbox runner that compiles/runs a generated Rust test or harness and reports pass/fail.
- Findings annotated with a `confirmed` status when the PoC demonstrates the issue.

**Design.**
- **Isolation first.** Execution is opt-in (`--prove`), runs only against the user's own code, in a constrained sandbox (container/`nextest`/resource + network limits). This is the first phase that runs target code — it stays firmly inside the §9 guardrails (owner's code only, no live/remote targets).
- **PoC generation → verification loop.** For a candidate finding, the agent writes a focused `#[test]` or small harness expressing the attack (e.g. an input that triggers the panic, a traversal path, an injected argument); the runner executes it; a demonstrated failure/crash promotes the finding to `confirmed` with the captured output as evidence.
- **Schema.** Add a `verification` field to `Finding` (`unverified` | `confirmed` | `refuted`) and reflect it in reports/SARIF; ranking can boost confirmed findings.

**Acceptance.** For a subset of fixture/corpus findings, Snitch generates a PoC that the sandbox runs and that demonstrably fails on the vulnerable code and passes on the patched code.

**Risks.** Arbitrary code execution — the sandbox is the critical control; default off, explicit opt-in, documented blast radius. Compile times/flakiness — cap time and treat inconclusive as `unverified`, never a false `confirmed`.

---

## 8. Testing & evaluation — the open-source corpus

The key insight: **we don't hand-write vulnerable code — we use real crates with known, labeled vulnerabilities as ground truth**, then measure whether the scanner rediscovers them.

### 8a. Ground-truth sources (confirmed real)
- **RustSec `advisory-db`** (`github.com/rustsec/advisory-db`) — canonical labeled dataset: TOML advisories per crate + affected version ranges + category, often with the patched version/commit. This is the gold mine for both the dependency layer *and* evaluation labels.
- **`cargo-audit` / `rustsec` crate** — reference implementation and test fixtures for the advisory layer.
- **OSS-Fuzz Rust projects** — many have historical memory/panic bugs with the fixing commit recorded.

### 8b. Evaluation methodology — "pre-fix checkout"
For a crate with a RustSec advisory that names a fixed version:
1. Check out the last **vulnerable** release/commit.
2. Run `snitch scan`.
3. Score: did it surface the issue the patch fixed? (true positive)
4. Run against the **patched** commit → it should *not* re-flag it (false-positive check).

This yields a reproducible, real benchmark with labels straight from advisory-db — far stronger than synthetic tests. We track **precision / recall / ranking quality** per threat category as the primary quality metric across phases.

### 8c. Corpus to curate (next step — needs sourcing & verification)
A curated list of ~15–30 target repos/commits, spanning the §3 categories:
- Crates with notable advisories across categories (memory/`unsafe`, panic/DoS, injection, deserialization, crypto-misuse, dependency).
- 1–2 real Rust web apps (axum/actix) for app-logic/authz findings.
- A small **seeded fixture crate** we own, with one clean example per §3 category, for fast unit-level regression tests (complements, doesn't replace, the real corpus).

> **Action item:** I'll research and propose the concrete repo+commit list (with the advisory id each one anchors to) as a follow-up, and we confirm it together before Phase 1. I'm deliberately not hardcoding specific repo names here until each is verified against a real advisory.

### 8d. Test layers
- **Unit:** taxonomy modules, finding scoring, SARIF emitter, advisory parsing (fast, offline, deterministic).
- **Fixture integration:** seeded crate → known findings (offline, deterministic).
- **Corpus eval:** pre-fix checkouts → precision/recall (needs network + model; run as a separate benchmark, not the unit CI).
- **Existing suite:** stays green throughout.

---

## 9. Guardrails (offensive tooling, used responsibly)

- v1 is **static analysis of code you point it at** — no execution against live/remote systems.
- Sandboxed PoC (Phase 5) runs only against the user's own code in isolation.
- Any future live-target mode is authorization-gated and scope-restricted by design.
- No generation of evasion/weaponized payloads aimed at third-party systems; the goal is proving exploitability in *your* code within *your* dev cycle.

---

## 10. Decisions — resolved

All four opening questions are settled (see §2, confirmed 2026-10-31): scope locked, name kept, GitHub Actions + SARIF as the CI target, panic/DoS + injection first.

**Next up:**
1. Provide an OpenRouter key so the scan can be validated end-to-end against the fixture crate and a real repo.
2. Curate the real-repo eval corpus (§8c), each target anchored to a RustSec advisory, then wire the "pre-fix checkout" benchmark (Phase 2/3).
3. Decide whether to rebrand the top-level README now or after Phase 1 is validated live.
