# Snitch — Decision Log

> Newest first. Each entry: what was decided, why, and what was rejected.

## 2026-10-01 — The scanner reads files directly instead of going through the agent tools (Phase 8)

**Decided**: `security/mapper.ts` uses `tinyglobby` + `fs` directly rather than calling the `glob`/`grep`/`read_file` tool objects, even though the README describes stages 1-2 as "built on" those tools. Pairing is a deliberately shallow heuristic: same-file source x sink, plus one hop cross-file when the source's file calls the sink's enclosing function by name.
**Why**: The tools' `execute()` returns strings formatted for a model to read; the scanner needs structured hits (file, line, enclosing fn, spans) and would have to re-parse its own output. The primitives are the same — the "built on" claim holds at the conceptual level. Shallow pairing is acceptable because stage 3 (the trace sub-agent) is the precision filter; stages 1-2 only need recall on realistic shapes, deterministically and for free.
**Rejected**: Routing through the tool registry (string re-parsing, approval plumbing for a read-only scan); real call-graph analysis via a Rust parser (a heavy dependency against the project's lightweight constraint — revisit if cross-file recall proves too weak on real repos); regex-only "taint tracking" (false precision; reasoning about reachability is exactly what stage 3 is for).

## 2026-10-01 — Subscription path rides the Agent SDK behind PromptToolAdapter (Phase 7)

**Decided**: `SubscriptionProvider` implements `LLMProvider` by calling the Claude Agent SDK's `query()` with `allowedTools: []` and `maxTurns: 1`, flattening the full history into one prompt per call and reading back assistant text + result usage. It declares `nativeTools: false`, so `createProvider` always wraps it in the existing `PromptToolAdapter` — snitch's own tools drive the loop via fenced JSON, exactly like any other no-native-tools model. The SDK is an optional peer dependency loaded via dynamic import (variable specifier, so tsc doesn't require its types); a missing install produces an actionable error. `ANTHROPIC_API_KEY` is deleted from the env handed to the SDK, since the SDK silently prefers it over the OAuth token and would bill API credits; a startup warning explains when both are set.
**Why**: Claude Max users should run snitch with zero API billing. The SDK is the only supported bridge to subscription auth, but it is an agent runner, not a chat API — disabling its tools and single-turning it reduces it to a plain model call that fits the existing provider contract, and the prompt-tools adapter (built in Phase 6 for Laguna) already solves "capable model, no tool API" without new machinery.
**Rejected**: Making the SDK a hard dependency (BYOK installs shouldn't pull a whole agent runtime); letting the SDK run its own tools (two approval systems and nested agents); erroring when ANTHROPIC_API_KEY coexists with the token (a user with both set for other tools would be blocked; scrub + warn preserves intent).

## 2026-10-01 — One auth resolution, four provider paths, redaction at the error boundary (Phase 7)

**Decided**: `config.ts` resolves credentials once into a `ResolvedAuth` union with fixed priority — subscription token, OpenRouter key, Anthropic key, OpenAI key — and `createProvider` is the single switch mapping auth to provider. OpenAI direct reuses `OpenRouterProvider` with a `flavor: 'openai'` option (dialect differences: `stream_options` vs `usage`, no `X-Title`); Anthropic direct gets a real `AnthropicProvider` because the Messages API is a genuinely different wire format (system param, content blocks, alternating roles, `stop_reason`). Every credential read is registered with `util/redact.ts`, and `SnitchError` scrubs registered secrets at construction.
**Why**: Priority must be deterministic and documented, not dependent on which code path asks first. Redacting inside the error type covers every surface (TUI, headless stderr, echoed API bodies) without each call site remembering to sanitize — it's a security tool; leaking a key in an error trace is its own vulnerability class.
**Rejected**: A separate OpenAI provider class (the chat-completions dialects differ by two fields — a flavor flag beats a copy); converting Anthropic through an OpenAI-compat shim (loses native tool_use streaming and clean stop-reason mapping); redacting at print sites only (misses future surfaces by default).

## 2026-09-03 — Plan mode removes tools instead of asking nicely

**Decided**: `/plan` (TUI) and `--plan` (headless) run the loop against `registry.readOnlyView()` — only no-approval tools exist for that turn — plus a plan-only instruction appended to the task. Toggling shows a `[plan]` status badge.
**Why**: A small model cannot be trusted to obey "do not edit" as an instruction alone; removing the mutating tools from the wire payload makes violation impossible rather than discouraged. requiresApproval doubles as the read-only marker, so the view needs no new metadata.
**Rejected**: Prompt-only plan mode (unenforceable); auto-denying mutating calls (wastes a model round trip per attempt and fills history with denials).

## 2026-09-03 — Compaction complements trimming

**Decided**: `/compact` and an automatic pre-task pass (at >80% of the token budget) have the model summarize everything except the last 6 messages; `History.compact()` swaps the old messages for the summary as a user note, keeping the tail orphan-safe. Trimming in `toMessages()` stays as the silent last-resort safety net.
**Why**: Trimming loses information; compaction preserves it in condensed form. Manual + threshold-triggered keeps compaction calls rare on the free tier.
**Rejected**: Compacting inside runAgent (would need provider access in every consumer and a new event type); summarizing on every turn (too many extra model calls).

**Decided**: `task(description, prompt)` runs a fresh agent loop (empty History, same system prompt, fresh default registry) to completion and returns its final text. The sub-agent auto-approves its own tool calls; instead, `task` itself is approval-gated and its preview shows the sub-agent's prompt plus a warning. Recursion is impossible by construction: `task` is registered on top of `createDefaultRegistry()` by the entry points, and sub-agents get a plain default registry. The file lives in `src/agent/` because it depends on the loop.
**Why**: Delegation keeps big exploratory work out of the parent's context. Per-call approvals inside a sub-agent would defeat the point and double-prompt the human, so trust is granted once, at the spawn, with the prompt visible. `getProvider` is a callback so a mid-session /model switch reaches sub-agents.
**Rejected**: registering `task` in the default registry with a depth counter (implicit recursion limits are easier to get wrong than absence); read-only classification (a sub-agent can write files and run commands — the gate must be at the spawn); forwarding sub-agent usage into the parent's token tally (deferred; totals currently undercount sub-agent work).

**Decided**: `resolveShell()` picks the shell once: Git Bash (`Git\bin\bash.exe` under ProgramFiles/LOCALAPPDATA) when installed on Windows, cmd.exe otherwise, platform `sh` elsewhere. The chosen shell's name is injected into the system prompt so the model writes the right dialect.
**Why**: A consistent POSIX dialect across platforms means the model never has to reason about cmd quirks; small models especially emit bash-isms regardless. Verified live: `&&` chains and coreutils work on Windows through Git Bash.
**Rejected**: WSL's System32 bash.exe (executes inside the WSL filesystem, not the project's); requiring bash (cmd fallback keeps zero hard dependencies); per-command shell selection (one shell per session keeps the prompt truthful).

**Decided**: The input line stays active during a run; Enter enqueues the message and a React effect drains the queue one item per idle pass. Input deactivates only in approval mode.
**Why**: Standard terminal-agent UX — the user should never be locked out of typing their next instruction. Draining from an effect (not the finished run's closure) keeps provider/model state fresh, so a queued `/model` applies to tasks behind it. Approval mode must own the keyboard exclusively or `y`/`n` keystrokes would double as task text.
**Rejected**: Submitting queued text mid-run into the live conversation (would interleave with tool turns the model hasn't finished); leaving input disabled (the complaint that prompted this).

**Decided**: `extractToolCalls` accepts both the instructed fenced-JSON blocks and `<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>` markup. XML arg values are coerced to numbers/booleans only when the whole value is an unambiguous scalar; everything else stays a verbatim string.
**Why**: First live `--prompt-tools` run showed Laguna ignores the fenced-JSON instruction and emits its trained XML format, so the fallback silently did nothing. Scalar-only coercion prevents mangling file content that happens to look like JSON.
**Rejected**: Prompt engineering alone (the trained format wins over instructions); blanket `JSON.parse` on arg values (would corrupt JSON-looking string content).

## 2026-09-03 — Headless --yes flag; closed stdin denies instead of crashing

**Decided**: `--yes`/`-y` auto-approves every tool call in headless mode; if stdin has ended when an approval prompt fires, the call is denied with a hint instead of throwing.
**Why**: Live E2E via piped stdin crashed with `ERR_USE_AFTER_CLOSE` — piped input EOFs before the model finishes streaming, closing readline before the first `question()`. Scripted runs need a non-interactive approval path.
**Rejected**: Re-buffering piped answers ourselves (fragile ordering against streamed prompts); auto-approving on EOF (unsafe default).

## 2026-09-02 — Prompt-tools fallback flattens tool messages to user text

**Decided**: `PromptToolAdapter` buffers each reply (no live deltas), extracts fenced ` ```tool_call ` JSON blocks as tool calls, rewrites assistant tool_calls into the same fenced form, and converts `role: "tool"` results into `[tool result]` user messages.
**Why**: Models without native tool calling reject `role: "tool"` and `tool_calls` fields, and Laguna has no JSON mode, so parsing must be lenient (unparseable blocks stay visible in text rather than crashing). Buffering is required because call blocks must be stripped before display.
**Rejected**: XML-style call syntax (JSON is what tool-trained models emit most reliably); streaming with post-hoc cleanup (flickers the call block at the user).

## 2026-09-02 — /clear remounts <Static> via a generation key

**Decided**: Clearing the transcript replaces the History instance, empties the items array, and bumps a `key` on `<Static>` to remount it.
**Why**: Ink's `<Static>` tracks how many items it has already emitted; shrinking the array without a remount would silently skip that many future items.

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
