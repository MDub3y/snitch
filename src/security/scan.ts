import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { History } from '../agent/history.js';
import { runAgent } from '../agent/loop.js';
import type { SnitchConfig } from '../config.js';
import { createProvider } from '../llm/factory.js';
import type { LLMProvider } from '../llm/types.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { FindingsCollector } from '../tools/security.js';
import { dedupeFindings, meetsThreshold, rankFindings, summarize, type Finding, type Severity } from './findings.js';
import { buildScanSystemPrompt } from './prompts.js';
import { toMarkdownReport } from './report/markdown.js';
import { toSarifJson } from './report/sarif.js';

export interface ScanOptions {
  /** Repo root to scan (becomes the tools' cwd). */
  path: string;
  /** Base git ref: scan only Rust files changed since this ref. */
  diff?: string;
  /** Write SARIF 2.1.0 here (for GitHub code-scanning). */
  sarifPath?: string;
  /** Write the Markdown report here instead of stdout. */
  reportPath?: string;
  /** Exit non-zero if any finding is at least this severe. */
  failOn: Severity;
  /** Inject a provider (tests); defaults to the one built from config. */
  providerOverride?: LLMProvider;
  /** Silence progress written to stderr (tests). */
  quiet?: boolean;
}

const MAX_FILES_LISTED = 200;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Rust files changed since `ref` (added/copied/modified/renamed), relative paths. */
function changedRustFiles(cwd: string, ref: string): string[] {
  const out = git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', `${ref}...HEAD`]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.rs'));
}

/** Tracked Rust files in the repo, relative paths. */
function trackedRustFiles(cwd: string): string[] {
  const out = git(cwd, ['ls-files', '*.rs']);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function describeScope(options: ScanOptions): { scope: string; files: string[] } {
  if (options.diff) {
    const files = changedRustFiles(options.path, options.diff);
    return {
      scope: `Rust files changed since \`${options.diff}\` (${files.length}). Focus on newly introduced risk; read surrounding/called code as needed for reachability.`,
      files,
    };
  }
  const files = trackedRustFiles(options.path);
  return { scope: `the whole repository (${files.length} Rust file(s))`, files };
}

function buildScanMessage(scope: string, files: string[]): string {
  if (files.length === 0) {
    return `Scope: ${scope}\n\nNo Rust files were found in scope. Use glob/list_dir to confirm, and if there genuinely are none, report that and stop.`;
  }
  const shown = files.slice(0, MAX_FILES_LISTED).map((file) => `- ${file}`);
  const more = files.length > MAX_FILES_LISTED ? `\n...and ${files.length - MAX_FILES_LISTED} more (use glob to enumerate).` : '';
  return `Scope: ${scope}\n\nRust files in scope:\n${shown.join('\n')}${more}\n\nBegin by mapping entry points, then investigate the highest-risk sinks. Record each real finding with emit_finding.`;
}

export interface ScanResult {
  findings: Finding[];
  /** True when findings meet the --fail-on threshold. */
  failed: boolean;
}

/**
 * Runs a security scan: the agent loop against read-only tools plus
 * emit_finding, then collects, ranks and writes the findings. Reuses the same
 * loop and provider as the coding agent — only the toolset, prompt and output
 * differ.
 */
export async function runScan(config: SnitchConfig, options: ScanOptions): Promise<ScanResult> {
  const cwd = path.resolve(options.path);
  if (!fs.existsSync(cwd)) throw new Error(`Scan path does not exist: ${cwd}`);
  const log = (message: string) => {
    if (!options.quiet) process.stderr.write(message);
  };

  const provider = options.providerOverride ?? createProvider(config);

  const collector = new FindingsCollector();
  const registry = createDefaultRegistry();
  registry.register(collector.tool);
  // Read-only view: drops write_file/edit_file/run_command/task, keeps the
  // read tools and emit_finding — the scan physically cannot mutate the target.
  const scanRegistry = registry.readOnlyView();

  const { scope, files } = describeScope(options);
  log(`[snitch] scanning ${cwd} — ${scope}\n`);

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  try {
    const events = runAgent(buildScanMessage(scope, files), {
      provider,
      registry: scanRegistry,
      history: new History(buildScanSystemPrompt(cwd, scope)),
      cwd,
      maxIterations: config.maxIterations,
      tokenBudget: config.tokenBudget,
      signal: controller.signal,
      onRetry: ({ status, attempt, maxAttempts, delayMs }) =>
        log(`[snitch] ${status} from OpenRouter, retry ${attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s...\n`),
    });

    for await (const event of events) {
      switch (event.type) {
        case 'tool_call_start':
          log(`[tool] ${event.call.name} ${event.call.rawArguments.slice(0, 160)}\n`);
          break;
        case 'approval_required':
          // No approval-gated tools are in the read-only view; deny defensively.
          event.respond(false);
          break;
        case 'tool_result':
          if (event.name === 'emit_finding') log(`[finding] ${event.result.split('\n')[0]}\n`);
          break;
        case 'assistant_message':
          if (event.content.trim()) log(`\n[snitch] ${event.content.trim()}\n`);
          break;
        case 'done':
          if (event.reason === 'max_iterations') {
            log(`[snitch] stopped at the ${config.maxIterations}-iteration limit; results may be incomplete.\n`);
          } else if (event.reason === 'cancelled') {
            log('[snitch] cancelled; reporting findings gathered so far.\n');
          } else if (event.reason === 'error') {
            log(`[snitch] error: ${event.error}\n`);
          }
          break;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  const findings = rankFindings(dedupeFindings([...collector.getFindings()]));
  const counts = summarize(findings);

  const report = toMarkdownReport(findings, options.diff ? `${cwd} (diff vs ${options.diff})` : cwd);
  if (options.reportPath) {
    fs.writeFileSync(options.reportPath, report);
    log(`[snitch] report written to ${options.reportPath}\n`);
  } else {
    process.stdout.write(`\n${report}`);
  }

  if (options.sarifPath) {
    fs.writeFileSync(options.sarifPath, toSarifJson(findings));
    log(`[snitch] SARIF written to ${options.sarifPath}\n`);
  }

  const failed = meetsThreshold(findings, options.failOn);
  log(
    `[snitch] ${counts.total} finding(s): ${counts.bySeverity.critical} critical, ${counts.bySeverity.high} high, ${counts.bySeverity.medium} medium, ${counts.bySeverity.low} low, ${counts.bySeverity.info} info (${counts.reachable} reachable).\n`,
  );
  return { findings, failed };
}
