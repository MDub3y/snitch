import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SnitchConfig } from '../src/config.js';
import { runScan } from '../src/security/scan.js';
import { FakeProvider, textTurn, toolTurn } from './helpers/fakeProvider.js';

const config: SnitchConfig = {
  apiKey: 'test',
  model: 'fake/model',
  baseUrl: 'http://localhost',
  tokenBudget: 200_000,
  maxIterations: 24,
  promptTools: false,
};

const fixture = path.resolve(__dirname, 'fixtures/rust-vuln');

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snitch-scan-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function emit(args: Record<string, unknown>): string {
  return JSON.stringify(args);
}

describe('runScan (end-to-end with a scripted provider)', () => {
  it('drives the loop, collects findings, writes report + SARIF, and gates on severity', async () => {
    const out = tmp();
    const reportPath = path.join(out, 'report.md');
    const sarifPath = path.join(out, 'out.sarif');

    // Turn 1: the "agent" records two findings; turn 2: a final summary.
    const provider = new FakeProvider([
      toolTurn([
        {
          id: 'c1',
          name: 'emit_finding',
          args: emit({
            category: 'command-injection',
            title: 'shell out with user-controlled cmd',
            file: 'src/main.rs',
            line: 38,
            severity: 'critical',
            reachable: true,
            attackerControl: 'full',
            confidence: 'high',
            entryPoint: 'run_user_command(req)',
            dataFlow: 'req.cmd -> Command::new("sh").arg("-c")',
            evidence: 'Command::new("sh").arg("-c").arg(&req.cmd)',
            candidatePoc: 'cmd = "; cat /etc/passwd"',
          }),
        },
        {
          id: 'c2',
          name: 'emit_finding',
          args: emit({
            category: 'unsafe-memory',
            title: 'theoretical from_raw_parts in dead code',
            file: 'src/util.rs',
            line: 3,
            severity: 'medium',
            reachable: false,
            attackerControl: 'none',
            confidence: 'low',
            evidence: 'slice::from_raw_parts(p, 4)',
          }),
        },
      ]),
      textTurn('Found 2 issues; the command injection is the serious one.'),
    ]);

    const { findings, failed } = await runScan(config, {
      path: fixture,
      failOn: 'high',
      reportPath,
      sarifPath,
      providerOverride: provider,
      quiet: true,
    });

    // Both findings collected; ranked with the reachable critical first.
    expect(findings).toHaveLength(2);
    expect(findings[0]!.category).toBe('command-injection');
    expect(findings[1]!.category).toBe('unsafe-memory');

    // A critical finding meets the `high` gate.
    expect(failed).toBe(true);

    // Reports written and well-formed.
    const report = fs.readFileSync(reportPath, 'utf8');
    expect(report).toContain('shell out with user-controlled cmd');
    expect(report).toContain('src/main.rs:38');

    const sarif = JSON.parse(fs.readFileSync(sarifPath, 'utf8'));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results[0].ruleId).toBe('command-injection');

    // The scan prompt carried the attacker persona and scope to the model.
    const systemPrompt = provider.seenMessages[0]![0]!;
    expect(systemPrompt.role).toBe('system');
    expect(systemPrompt.content).toContain('offensive-security');
  });

  it('does not gate when all findings are below the threshold', async () => {
    const provider = new FakeProvider([
      toolTurn([
        {
          id: 'c1',
          name: 'emit_finding',
          args: emit({
            category: 'crypto-misuse',
            title: 'md5 used for a cache key',
            file: 'src/main.rs',
            line: 5,
            severity: 'low',
            reachable: true,
            attackerControl: 'none',
            confidence: 'medium',
            evidence: 'md5(key)',
          }),
        },
      ]),
      textTurn('One low-severity note.'),
    ]);

    const { failed } = await runScan(config, {
      path: fixture,
      failOn: 'high',
      reportPath: path.join(tmp(), 'r.md'),
      providerOverride: provider,
      quiet: true,
    });
    expect(failed).toBe(false);
  });

  it('throws on a non-existent scan path', async () => {
    await expect(
      runScan(config, { path: '/no/such/dir', failOn: 'high', providerOverride: new FakeProvider([]), quiet: true }),
    ).rejects.toThrow(/does not exist/);
  });
});
