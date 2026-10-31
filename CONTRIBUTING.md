# Contributing to Snitch

Thanks for your interest in Snitch — a Rust-first offensive-security scanner
built on a small TypeScript agent loop. Contributions are welcome.

## Getting started

```sh
npm install
npm run build      # tsc -> dist/
npm test           # vitest
npx tsc --noEmit   # typecheck
```

Node.js ≥ 22 is required.

## Ground rules

- **The agent loop (`src/agent/loop.ts`) is intentionally stable.** Add
  capabilities through the `security/` module and new tools, not by reshaping
  the loop.
- **Keep the suite green and add tests for what you build.** Pure modules
  (findings, taxonomy, reports, translation) are unit-tested offline; prefer
  that over tests that need a live model.
- **Match the surrounding style** — small, documented modules; the `Tool`
  contract for new tools; typed errors.
- Typecheck, build, and tests must pass before a PR is ready for review.

## Scope and safety

Snitch is offensive-security tooling with a defensive purpose: proving what is
exploitable in code **you own**, inside your own development cycle. Please keep
contributions within that scope — see [SECURITY.md](SECURITY.md) and the
guardrails in [docs/SECURITY-PLAN.md](docs/SECURITY-PLAN.md). We don't accept
features aimed at attacking third-party systems, evasion, or weaponized
payloads.

## Pull requests

- Branch from `main`, keep PRs focused, and describe the whole change.
- Reference the relevant phase/mission in [docs/SECURITY-PLAN.md](docs/SECURITY-PLAN.md)
  when applicable.
- By contributing you agree your work is licensed under the project's
  [MIT License](LICENSE).

## Roadmap

The phased plan and the contributor mission brief live in
[docs/SECURITY-PLAN.md](docs/SECURITY-PLAN.md) and
[docs/MISSION-BRIEF.md](docs/MISSION-BRIEF.md).
