import { describe, expect, it } from 'vitest';
import {
  dedupeFindings,
  exploitabilityScore,
  meetsThreshold,
  rankFindings,
  summarize,
  type Finding,
} from '../src/security/findings.js';

function make(overrides: Partial<Finding> = {}): Finding {
  return {
    category: 'panic-dos',
    title: 'unwrap on request body',
    file: 'src/handler.rs',
    severity: 'high',
    reachable: true,
    attackerControl: 'full',
    confidence: 'high',
    evidence: 'body.parse().unwrap()',
    ...overrides,
  };
}

describe('exploitabilityScore', () => {
  it('discounts unreachable findings so real paths rank higher', () => {
    const reachable = make({ reachable: true });
    const unreachable = make({ reachable: false });
    expect(exploitabilityScore(reachable)).toBeGreaterThan(exploitabilityScore(unreachable));
  });

  it('rewards attacker control and confidence', () => {
    const strong = make({ attackerControl: 'full', confidence: 'high' });
    const weak = make({ attackerControl: 'none', confidence: 'low' });
    expect(exploitabilityScore(strong)).toBeGreaterThan(exploitabilityScore(weak));
  });

  it('a reachable, fully-controlled high outranks an unreachable critical', () => {
    const realHigh = make({ severity: 'high', reachable: true, attackerControl: 'full', confidence: 'high' });
    const deadCritical = make({ severity: 'critical', reachable: false, attackerControl: 'none', confidence: 'low' });
    expect(exploitabilityScore(realHigh)).toBeGreaterThan(exploitabilityScore(deadCritical));
  });
});

describe('rankFindings', () => {
  it('orders by exploitability, most serious first, and is stable', () => {
    const low = make({ title: 'a', severity: 'low', reachable: false, attackerControl: 'none', confidence: 'low' });
    const high = make({ title: 'b', severity: 'critical', reachable: true, attackerControl: 'full', confidence: 'high' });
    const mid = make({ title: 'c', severity: 'medium', reachable: true, attackerControl: 'partial', confidence: 'medium' });
    const ranked = rankFindings([low, high, mid]);
    expect(ranked.map((f) => f.title)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate its input', () => {
    const input = [make({ title: 'x' }), make({ title: 'y', severity: 'critical' })];
    const copy = [...input];
    rankFindings(input);
    expect(input).toEqual(copy);
  });
});

describe('dedupeFindings', () => {
  it('drops exact duplicates by category+file+line+title', () => {
    const a = make({ line: 10 });
    const b = make({ line: 10 });
    const c = make({ line: 11 });
    expect(dedupeFindings([a, b, c])).toHaveLength(2);
  });
});

describe('meetsThreshold', () => {
  it('is true when a finding meets or exceeds the threshold severity', () => {
    const findings = [make({ severity: 'medium' })];
    expect(meetsThreshold(findings, 'high')).toBe(false);
    expect(meetsThreshold(findings, 'medium')).toBe(true);
    expect(meetsThreshold(findings, 'low')).toBe(true);
  });

  it('is false for an empty finding set', () => {
    expect(meetsThreshold([], 'info')).toBe(false);
  });
});

describe('summarize', () => {
  it('counts totals, reachable, and per-severity', () => {
    const counts = summarize([
      make({ severity: 'critical', reachable: true }),
      make({ severity: 'high', reachable: false }),
      make({ severity: 'high', reachable: true }),
    ]);
    expect(counts.total).toBe(3);
    expect(counts.reachable).toBe(2);
    expect(counts.bySeverity.high).toBe(2);
    expect(counts.bySeverity.critical).toBe(1);
  });
});
