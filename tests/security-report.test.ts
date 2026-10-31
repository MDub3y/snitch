import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/security/findings.js';
import { toMarkdownReport } from '../src/security/report/markdown.js';
import { buildSarif, toSarifJson } from '../src/security/report/sarif.js';
import { CATEGORY_IDS, renderTaxonomy, TAXONOMY } from '../src/security/taxonomy.js';

const findings: Finding[] = [
  {
    category: 'panic-dos',
    title: 'unwrap on untrusted length',
    file: 'src/parse.rs',
    line: 12,
    endLine: 14,
    severity: 'high',
    reachable: true,
    attackerControl: 'full',
    confidence: 'high',
    evidence: 'let n = header.len_field; buf[..n].to_vec()',
    entryPoint: 'parse_frame(bytes) from the TCP handler',
    dataFlow: 'socket -> header.len_field -> slice index',
    candidatePoc: 'Send a frame with len_field > buf.len().',
  },
  {
    category: 'unsafe-memory',
    title: 'from_raw_parts with dead length',
    file: 'src/util.rs',
    line: 3,
    severity: 'medium',
    reachable: false,
    attackerControl: 'none',
    confidence: 'low',
    evidence: 'slice::from_raw_parts(p, 4)',
  },
];

describe('taxonomy', () => {
  it('has unique ids and at least the phase-1 categories', () => {
    expect(new Set(CATEGORY_IDS).size).toBe(CATEGORY_IDS.length);
    const phase1 = TAXONOMY.filter((c) => c.phase1).map((c) => c.id);
    expect(phase1).toEqual(expect.arrayContaining(['panic-dos', 'command-injection', 'path-traversal', 'sql-injection']));
  });

  it('renders phase-1 categories first and marks them', () => {
    const text = renderTaxonomy();
    expect(text).toContain('[PRIORITY]');
    expect(text.indexOf('panic-dos')).toBeLessThan(text.indexOf('unsafe-memory'));
  });
});

describe('markdown report', () => {
  it('ranks the reachable high above the unreachable medium and shows a summary', () => {
    const md = toMarkdownReport(findings, '/repo');
    expect(md).toContain('**2 finding(s)**');
    expect(md).toContain('1 judged reachable');
    expect(md.indexOf('unwrap on untrusted length')).toBeLessThan(md.indexOf('from_raw_parts with dead length'));
    expect(md).toContain('src/parse.rs:12-14');
    expect(md).toContain('Candidate proof-of-exploit');
  });

  it('renders a clear empty state', () => {
    expect(toMarkdownReport([], '/repo')).toContain('No findings');
  });
});

describe('SARIF report', () => {
  it('produces valid-shaped SARIF 2.1.0 with a rule per category', () => {
    const sarif = buildSarif(findings) as any;
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('Snitch');
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(TAXONOMY.length);
    expect(sarif.runs[0].results).toHaveLength(2);
  });

  it('maps severities onto SARIF levels and carries exploitability properties', () => {
    const sarif = buildSarif(findings) as any;
    const [first] = sarif.runs[0].results; // ranked: the reachable high is first
    expect(first.ruleId).toBe('panic-dos');
    expect(first.level).toBe('error');
    expect(first.locations[0].physicalLocation.region.startLine).toBe(12);
    expect(first.properties.reachable).toBe(true);
    expect(first.properties.attackerControl).toBe('full');
  });

  it('serializes to pretty JSON ending in a newline', () => {
    const json = toSarifJson(findings);
    expect(json.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
