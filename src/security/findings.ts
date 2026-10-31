/**
 * The structured output of a scan. A Finding is not just "here is a suspicious
 * line" — it carries the scanner's reasoning about whether the weakness is
 * actually reachable from an attacker-controlled entry point and how much the
 * attacker controls, so findings can be ranked by real exploitability rather
 * than by raw pattern severity. This whole module is pure (no I/O, no model),
 * so scoring, ranking, dedup and report shaping are unit-testable offline.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** How much of the trigger an attacker controls. */
export const ATTACKER_CONTROL = ['full', 'partial', 'none'] as const;
export type AttackerControl = (typeof ATTACKER_CONTROL)[number];

export const CONFIDENCE = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export interface Finding {
  /** Taxonomy id, e.g. 'panic-dos' or 'command-injection'. */
  category: string;
  /** One-line human summary. */
  title: string;
  file: string;
  line?: number;
  endLine?: number;
  /** Impact if exploited. */
  severity: Severity;
  /** Is the sink on a real path from an entry point? The core "is it real" bit. */
  reachable: boolean;
  attackerControl: AttackerControl;
  confidence: Confidence;
  /** Where the attacker-controlled data originates (handler, CLI arg, FFI, ...). */
  entryPoint?: string;
  /** Traced path from source to sink. */
  dataFlow?: string;
  /** What must hold for the trigger (feature flag, auth state, config). */
  preconditions?: string;
  /** Quoted code plus the reasoning that makes this exploitable. */
  evidence: string;
  /** A described attack or candidate failing test (not executed in v1). */
  candidatePoc?: string;
  /** RustSec / CVE ids when dependency-related. */
  advisoryRefs?: string[];
}

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 15,
  info: 5,
};

const CONTROL_FACTOR: Record<AttackerControl, number> = {
  full: 1,
  partial: 0.7,
  none: 0.4,
};

const CONFIDENCE_FACTOR: Record<Confidence, number> = {
  high: 1,
  medium: 0.75,
  low: 0.5,
};

/** Unreachable issues are kept but heavily discounted so real paths float up. */
const UNREACHABLE_FACTOR = 0.3;

/**
 * Exploitability score used only for ranking (0–100-ish). A reachable remote
 * DoS an attacker fully controls outranks a high-severity `unsafe` sitting in
 * dead code — that ordering is the product's whole point.
 */
export function exploitabilityScore(finding: Finding): number {
  return (
    SEVERITY_WEIGHT[finding.severity] *
    (finding.reachable ? 1 : UNREACHABLE_FACTOR) *
    CONTROL_FACTOR[finding.attackerControl] *
    CONFIDENCE_FACTOR[finding.confidence]
  );
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Highest exploitability first; ties broken by severity, then file/line for stable output. */
export function rankFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const byScore = exploitabilityScore(b) - exploitabilityScore(a);
    if (byScore !== 0) return byScore;
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byFile = a.file.localeCompare(b.file);
    if (byFile !== 0) return byFile;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

function dedupKey(finding: Finding): string {
  return `${finding.category}\u0000${finding.file}\u0000${finding.line ?? ''}\u0000${finding.title}`;
}

/** Drops exact duplicates (same category + file + line + title). */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const finding of findings) {
    const key = dedupKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

/** True when any finding meets or exceeds the threshold severity (for CI gating). */
export function meetsThreshold(findings: readonly Finding[], threshold: Severity): boolean {
  const limit = SEVERITY_RANK[threshold];
  return findings.some((finding) => SEVERITY_RANK[finding.severity] <= limit);
}

export interface FindingCounts {
  total: number;
  reachable: number;
  bySeverity: Record<Severity, number>;
}

export function summarize(findings: readonly Finding[]): FindingCounts {
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let reachable = 0;
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    if (finding.reachable) reachable += 1;
  }
  return { total: findings.length, reachable, bySeverity };
}
