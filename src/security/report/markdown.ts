/**
 * Human-readable scan report. Findings are ranked by exploitability so the
 * issues most worth acting on are at the top. Pure: findings in, Markdown out.
 */
import { exploitabilityScore, rankFindings, summarize, type Finding, type Severity } from '../findings.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'INFO',
};

function location(finding: Finding): string {
  if (finding.line === undefined) return finding.file;
  const end = finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : '';
  return `${finding.file}:${finding.line}${end}`;
}

function renderFinding(finding: Finding, index: number): string {
  const reach = finding.reachable ? 'reachable' : 'not proven reachable';
  const lines = [
    `### ${index}. [${SEVERITY_LABEL[finding.severity]}] ${finding.title}`,
    '',
    `- **Category:** \`${finding.category}\``,
    `- **Location:** \`${location(finding)}\``,
    `- **Exploitability:** ${reach}, attacker control \`${finding.attackerControl}\`, confidence \`${finding.confidence}\` (score ${Math.round(
      exploitabilityScore(finding),
    )})`,
  ];
  if (finding.entryPoint) lines.push(`- **Entry point:** ${finding.entryPoint}`);
  if (finding.dataFlow) lines.push(`- **Data flow:** ${finding.dataFlow}`);
  if (finding.preconditions) lines.push(`- **Preconditions:** ${finding.preconditions}`);
  if (finding.advisoryRefs?.length) lines.push(`- **Advisories:** ${finding.advisoryRefs.join(', ')}`);
  lines.push('', '**Evidence**', '', finding.evidence);
  if (finding.candidatePoc) lines.push('', '**Candidate proof-of-exploit**', '', finding.candidatePoc);
  return lines.join('\n');
}

export function toMarkdownReport(findings: readonly Finding[], target: string): string {
  const ranked = rankFindings(findings);
  const counts = summarize(ranked);
  const header = [
    '# Snitch security scan',
    '',
    `**Target:** \`${target}\``,
    '',
  ];

  if (ranked.length === 0) {
    return [...header, 'No findings. (This is not a proof of safety — it reflects what this scan reasoned about.)', ''].join(
      '\n',
    );
  }

  const severityLine = (['critical', 'high', 'medium', 'low', 'info'] as const)
    .filter((severity) => counts.bySeverity[severity] > 0)
    .map((severity) => `${counts.bySeverity[severity]} ${severity}`)
    .join(', ');

  const summary = [
    `**${counts.total} finding(s)** — ${severityLine}. ${counts.reachable} judged reachable from an entry point.`,
    '',
    'Ranked by exploitability (severity × reachability × attacker control × confidence).',
    '',
    '---',
    '',
  ];

  const body = ranked.map((finding, i) => renderFinding(finding, i + 1)).join('\n\n');
  return [...header, ...summary, body, ''].join('\n');
}
