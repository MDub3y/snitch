# Running Snitch in CI (GitHub Actions + SARIF)

Snitch's scan mode is built to gate the development cycle: run it on pull
requests, fail the build on exploitable findings, and publish results to the
repository's **Security → Code scanning** tab.

## Quick start

1. Add an OpenRouter key as a repository secret named `SNITCH_API_KEY` (or sign
   the runner in to Claude and use `--provider anthropic`; see Authentication).
2. Add the workflow below as `.github/workflows/snitch-scan.yml` in the target
   repository.

The workflow scans only the Rust files changed in the PR (`--diff`), writes
SARIF, and uploads it with `github/codeql-action/upload-sarif`. Findings then
appear inline on the PR's changed lines.

```yaml
name: Snitch security scan

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write   # required to upload SARIF to code scanning

jobs:
  snitch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0     # needed for --diff against the base branch

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install Snitch
        run: npm install -g snitch

      - name: Scan changed Rust files
        env:
          SNITCH_API_KEY: ${{ secrets.SNITCH_API_KEY }}
        run: |
          snitch scan . \
            --diff origin/${{ github.base_ref || 'main' }} \
            --sarif snitch.sarif \
            --fail-on high

      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: snitch.sarif
```

## The CLI

```sh
snitch scan [path]                 # scan a whole repo (default path: .)
  --diff <ref>                     # only Rust files changed since <ref> (PR mode)
  --sarif <file>                   # write SARIF 2.1.0 for code scanning
  --report <file>                  # write the Markdown report to a file (else stdout)
  --fail-on <severity>             # exit 1 if any finding is >= this (default: high)
  --provider anthropic|openrouter  # which LLM backend to use
  --model <id> / --prompt-tools    # same provider controls as the agent
```

## Authentication

Snitch can use either backend:

- **Your Claude subscription (no API key)** — `--provider anthropic`. The Anthropic
  SDK resolves credentials itself, in order: `ANTHROPIC_API_KEY`, then
  `ANTHROPIC_AUTH_TOKEN`, then an `ant auth login` / Claude Code OAuth profile on
  disk. If you're signed in to Claude, `snitch scan --provider anthropic` just
  works. Anthropic is auto-selected when an Anthropic credential is in the
  environment, or when you request a `claude-*` model. Default model:
  `claude-opus-5-5`.
- **OpenRouter** — set `SNITCH_API_KEY` (or `OPENROUTER_API_KEY`). Used by default
  otherwise.

## Exit codes

- `0` — no finding met the `--fail-on` threshold.
- `1` — at least one finding met the threshold (fails the CI job).

## What gets reported

Findings are ranked by **exploitability** — severity weighted by whether the
issue is reachable from an attacker-controlled entry point, how much the
attacker controls, and the scanner's confidence. Each SARIF result carries that
reasoning in its `properties` (reachable, attackerControl, confidence, entry
point, data flow), so a reviewer sees *why* it's exploitable, not just where.
