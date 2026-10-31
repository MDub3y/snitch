import { describe, expect, it } from 'vitest';
import { FindingsCollector } from '../src/tools/security.js';
import type { ToolContext } from '../src/tools/types.js';

const ctx: ToolContext = { cwd: '.' };

const valid = {
  category: 'command-injection',
  title: 'shell out with user input',
  file: 'src/exec.rs',
  line: 42,
  severity: 'critical',
  reachable: true,
  attackerControl: 'full',
  confidence: 'high',
  evidence: 'Command::new("sh").arg("-c").arg(user_input)',
};

describe('emit_finding tool', () => {
  it('is read-only (no approval) so it survives the scan view', () => {
    expect(new FindingsCollector().tool.requiresApproval).toBe(false);
  });

  it('records a valid finding and reads it back via the collector', async () => {
    const collector = new FindingsCollector();
    const result = await collector.tool.execute(valid, ctx);
    expect(result).toMatch(/Recorded critical command-injection at src\/exec\.rs:42/);
    const findings = collector.getFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: 'command-injection', line: 42, reachable: true });
  });

  it('binds state to the collector, not to the tool literal (this-binding)', async () => {
    const collector = new FindingsCollector();
    const { execute } = collector.tool; // detached call — `this` would be wrong if not captured
    await execute(valid, ctx);
    expect(collector.getFindings()).toHaveLength(1);
  });

  it('keeps findings per collector instance', async () => {
    const a = new FindingsCollector();
    const b = new FindingsCollector();
    await a.tool.execute(valid, ctx);
    expect(b.getFindings()).toHaveLength(0);
  });

  it('rejects an unknown category', async () => {
    const collector = new FindingsCollector();
    await expect(collector.tool.execute({ ...valid, category: 'made-up' }, ctx)).rejects.toThrow(/unknown category/);
  });

  it('rejects bad enum values and missing required fields', async () => {
    const collector = new FindingsCollector();
    await expect(collector.tool.execute({ ...valid, severity: 'spicy' }, ctx)).rejects.toThrow(/severity/);
    await expect(collector.tool.execute({ ...valid, attackerControl: 'some' }, ctx)).rejects.toThrow(/attackerControl/);
    const { evidence, ...noEvidence } = valid;
    void evidence;
    await expect(collector.tool.execute(noEvidence, ctx)).rejects.toThrow(/evidence/);
  });

  it('requires reachable to be a boolean', async () => {
    const collector = new FindingsCollector();
    await expect(collector.tool.execute({ ...valid, reachable: 'yes' }, ctx)).rejects.toThrow(/reachable/);
  });

  it('rejects a non-string advisoryRefs entry', async () => {
    const collector = new FindingsCollector();
    await expect(collector.tool.execute({ ...valid, advisoryRefs: [1] }, ctx)).rejects.toThrow(/advisoryRefs/);
  });

  it('accepts optional fields and drops omitted ones', async () => {
    const collector = new FindingsCollector();
    await collector.tool.execute(
      { ...valid, advisoryRefs: ['RUSTSEC-2021-0001'], dataFlow: 'arg -> Command', endLine: 44 },
      ctx,
    );
    const finding = collector.getFindings()[0]!;
    expect(finding.advisoryRefs).toEqual(['RUSTSEC-2021-0001']);
    expect(finding.dataFlow).toBe('arg -> Command');
    expect(finding.endLine).toBe(44);
    expect(finding.candidatePoc).toBeUndefined();
  });
});
