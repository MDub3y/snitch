/**
 * SARIF 2.1.0 output — the format GitHub code-scanning ingests, so a scan can
 * upload results straight into a repo's Security tab from a CI workflow. Pure:
 * findings in, SARIF log object out.
 */
import { rankFindings, type Finding, type Severity } from '../findings.js';
import { TAXONOMY } from '../taxonomy.js';

const TOOL_NAME = 'Snitch';
const INFO_URI = 'https://github.com/snitch-sec/snitch';

/** SARIF only has error/warning/note/none; map our five severities onto them. */
function sarifLevel(severity: Severity): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    default:
      return 'note';
  }
}

function toResult(finding: Finding): Record<string, unknown> {
  const region: Record<string, unknown> = {};
  if (finding.line !== undefined) region.startLine = finding.line;
  if (finding.endLine !== undefined) region.endLine = finding.endLine;

  const location: Record<string, unknown> = {
    physicalLocation: {
      artifactLocation: { uri: finding.file },
      ...(Object.keys(region).length > 0 ? { region } : {}),
    },
  };

  return {
    ruleId: finding.category,
    level: sarifLevel(finding.severity),
    message: { text: `${finding.title}\n\n${finding.evidence}` },
    locations: [location],
    properties: {
      severity: finding.severity,
      reachable: finding.reachable,
      attackerControl: finding.attackerControl,
      confidence: finding.confidence,
      ...(finding.entryPoint ? { entryPoint: finding.entryPoint } : {}),
      ...(finding.dataFlow ? { dataFlow: finding.dataFlow } : {}),
      ...(finding.preconditions ? { preconditions: finding.preconditions } : {}),
      ...(finding.candidatePoc ? { candidatePoc: finding.candidatePoc } : {}),
      ...(finding.advisoryRefs ? { advisoryRefs: finding.advisoryRefs } : {}),
    },
  };
}

export function buildSarif(findings: readonly Finding[], version = '0.1.0'): Record<string, unknown> {
  const rules = TAXONOMY.map((category) => ({
    id: category.id,
    name: category.title,
    shortDescription: { text: category.title },
    fullDescription: { text: category.description },
    properties: { phase1: category.phase1 },
  }));

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            informationUri: INFO_URI,
            version,
            rules,
          },
        },
        results: rankFindings(findings).map(toResult),
      },
    ],
  };
}

export function toSarifJson(findings: readonly Finding[], version?: string): string {
  return `${JSON.stringify(buildSarif(findings, version), null, 2)}\n`;
}
