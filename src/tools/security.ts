import {
  ATTACKER_CONTROL,
  CONFIDENCE,
  exploitabilityScore,
  SEVERITIES,
  type AttackerControl,
  type Confidence,
  type Finding,
  type Severity,
} from '../security/findings.js';
import { CATEGORY_IDS, isKnownCategory } from '../security/taxonomy.js';
import type { Tool } from './types.js';
import { ToolError } from './types.js';

function asString(value: unknown, field: string, { required }: { required: boolean }): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ToolError(`emit_finding: "${field}" is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`emit_finding: "${field}" must be a non-empty string`);
  }
  return value;
}

function asEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ToolError(`emit_finding: "${field}" must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function asOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ToolError(`emit_finding: "${field}" must be a positive integer line number`);
  }
  return value;
}

/**
 * Collects the findings a scan produces. The `emit_finding` tool records one
 * finding per call into this collector; the scan orchestrator reads them back
 * when the agent loop ends. Closure-held state, like the todo tool, so each
 * scan gets its own list. The tool is read-only (records, never mutates the
 * target), so it survives the registry's read-only view and needs no approval.
 */
export class FindingsCollector {
  private readonly findings: Finding[] = [];

  getFindings(): readonly Finding[] {
    return this.findings;
  }

  get tool(): Tool<Record<string, unknown>> {
    // The registry calls `tool.execute(args, ctx)`, so `this` inside execute
    // would be the tool literal, not the collector. Capture the collector.
    const collector = this;
    return {
      name: 'emit_finding',
      description:
        'Record ONE confirmed security finding. Call this only after you have traced the issue to an entry point and judged its exploitability — do not report raw pattern matches. Always set reachable/attackerControl/confidence honestly; an unreachable issue is still worth recording but will be ranked low. Call once per distinct finding.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [...CATEGORY_IDS],
            description: 'Taxonomy id this finding belongs to',
          },
          title: { type: 'string', description: 'One-line summary of the issue' },
          file: { type: 'string', description: 'Path to the file, relative to the repo root' },
          line: { type: 'integer', description: 'Start line (1-based), if known' },
          endLine: { type: 'integer', description: 'End line (1-based), if the issue spans a range' },
          severity: { type: 'string', enum: [...SEVERITIES], description: 'Impact if exploited' },
          reachable: {
            type: 'boolean',
            description: 'Is the sink on a real path from an attacker-controlled entry point?',
          },
          attackerControl: {
            type: 'string',
            enum: [...ATTACKER_CONTROL],
            description: 'How much of the trigger the attacker controls',
          },
          confidence: { type: 'string', enum: [...CONFIDENCE], description: 'Your confidence this is a real issue' },
          entryPoint: { type: 'string', description: 'Where the attacker-controlled data originates' },
          dataFlow: { type: 'string', description: 'Traced path from source to sink' },
          preconditions: { type: 'string', description: 'What must hold for the trigger (feature flag, auth, config)' },
          evidence: { type: 'string', description: 'Quoted code plus the reasoning that makes this exploitable' },
          candidatePoc: { type: 'string', description: 'A described attack or candidate failing test (not executed)' },
          advisoryRefs: {
            type: 'array',
            items: { type: 'string' },
            description: 'RustSec / CVE ids, when dependency-related',
          },
        },
        required: ['category', 'title', 'file', 'severity', 'reachable', 'attackerControl', 'confidence', 'evidence'],
      },
      requiresApproval: false,
      async execute(args) {
        const category = asString(args.category, 'category', { required: true })!;
        if (!isKnownCategory(category)) {
          throw new ToolError(`emit_finding: unknown category "${category}" — use one of ${CATEGORY_IDS.join(', ')}`);
        }
        if (typeof args.reachable !== 'boolean') {
          throw new ToolError('emit_finding: "reachable" must be a boolean');
        }
        let advisoryRefs: string[] | undefined;
        if (args.advisoryRefs !== undefined && args.advisoryRefs !== null) {
          if (!Array.isArray(args.advisoryRefs) || args.advisoryRefs.some((ref) => typeof ref !== 'string')) {
            throw new ToolError('emit_finding: "advisoryRefs" must be an array of strings');
          }
          advisoryRefs = args.advisoryRefs as string[];
        }

        const finding: Finding = {
          category,
          title: asString(args.title, 'title', { required: true })!,
          file: asString(args.file, 'file', { required: true })!,
          severity: asEnum<Severity>(args.severity, 'severity', SEVERITIES),
          reachable: args.reachable,
          attackerControl: asEnum<AttackerControl>(args.attackerControl, 'attackerControl', ATTACKER_CONTROL),
          confidence: asEnum<Confidence>(args.confidence, 'confidence', CONFIDENCE),
          evidence: asString(args.evidence, 'evidence', { required: true })!,
        };
        const line = asOptionalNumber(args.line, 'line');
        const endLine = asOptionalNumber(args.endLine, 'endLine');
        const entryPoint = asString(args.entryPoint, 'entryPoint', { required: false });
        const dataFlow = asString(args.dataFlow, 'dataFlow', { required: false });
        const preconditions = asString(args.preconditions, 'preconditions', { required: false });
        const candidatePoc = asString(args.candidatePoc, 'candidatePoc', { required: false });
        if (line !== undefined) finding.line = line;
        if (endLine !== undefined) finding.endLine = endLine;
        if (entryPoint !== undefined) finding.entryPoint = entryPoint;
        if (dataFlow !== undefined) finding.dataFlow = dataFlow;
        if (preconditions !== undefined) finding.preconditions = preconditions;
        if (candidatePoc !== undefined) finding.candidatePoc = candidatePoc;
        if (advisoryRefs !== undefined) finding.advisoryRefs = advisoryRefs;

        collector.findings.push(finding);
        const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
        return `Recorded ${finding.severity} ${finding.category} at ${where} (reachable=${finding.reachable}, score=${Math.round(
          exploitabilityScore(finding),
        )}). ${collector.findings.length} finding(s) so far.`;
      },
    };
  }
}
