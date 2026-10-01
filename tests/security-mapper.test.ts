import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRepo } from '../src/security/mapper.js';

const VULNERABLE = path.join(__dirname, 'fixtures', 'ssrf-vulnerable');
const SAFE = path.join(__dirname, 'fixtures', 'ssrf-safe');

describe('scanRepo on the vulnerable fixture', () => {
  it('finds every planted source and sink', async () => {
    const scan = await scanRepo(VULNERABLE);

    expect(scan.filesScanned).toBe(2);
    const sinkIds = scan.sinks.map((s) => `${s.patternId}@${s.location.file}`);
    expect(sinkIds).toContain('reqwest-free-fn@src/main.rs'); // reqwest::get in fetch_remote
    expect(sinkIds).toContain('reqwest-client-method@src/main.rs'); // client.post in register_webhook
    expect(sinkIds).toContain('reqwest-free-fn@src/proxy.rs'); // reqwest::get in forward

    const sourceIds = new Set(scan.sources.map((s) => s.patternId));
    expect(sourceIds).toContain('axum-extractor'); // Query / Json extractors
    expect(sourceIds).toContain('url-ish-field'); // url / callback_url struct fields

    expect(scan.sanitizers).toEqual([]); // nothing to downrank
  });

  it('pairs same-file candidates with no sanitizers and fn-scoped slices', async () => {
    const scan = await scanRepo(VULNERABLE);

    const direct = scan.candidates.filter((c) => c.sameFile);
    expect(direct.length).toBeGreaterThan(0);
    for (const candidate of scan.candidates) expect(candidate.sanitizers).toEqual([]);

    // the fetch_remote extractor paired with the reqwest::get two lines below it
    const fetchPair = scan.candidates.find(
      (c) => c.source.enclosingFn === 'fetch_remote' && c.sink.enclosingFn === 'fetch_remote',
    );
    expect(fetchPair).toBeDefined();
    const span = fetchPair!.slice.find((s) => s.file === 'src/main.rs')!;
    expect(span.startLine).toBeLessThanOrEqual(fetchPair!.source.location.line);
    expect(span.endLine).toBeGreaterThanOrEqual(fetchPair!.sink.location.line);
  });

  it('links the cross-file candidate via the sink\'s enclosing fn name', async () => {
    const scan = await scanRepo(VULNERABLE);

    const crossFile = scan.candidates.filter((c) => !c.sameFile && c.sink.location.file === 'src/proxy.rs');
    expect(crossFile.length).toBeGreaterThan(0); // mirror() calls proxy::forward()
    const candidate = crossFile[0]!;
    expect(candidate.sink.enclosingFn).toBe('forward');
    const files = candidate.slice.map((s) => s.file);
    expect(files).toContain('src/main.rs');
    expect(files).toContain('src/proxy.rs');
  });

  it('uses repo-relative forward-slash paths and 1-based lines', async () => {
    const scan = await scanRepo(VULNERABLE);
    for (const hit of [...scan.sources, ...scan.sinks]) {
      expect(hit.location.file).not.toMatch(/\\|^[A-Za-z]:/);
      expect(hit.location.line).toBeGreaterThan(0);
      expect(hit.location.snippet.length).toBeGreaterThan(0);
    }
  });
});

describe('scanRepo on the safe fixture', () => {
  it('still pairs candidates but attaches the sanitizer evidence', async () => {
    const scan = await scanRepo(SAFE);

    expect(scan.candidates.length).toBeGreaterThan(0);
    const sanitizerIds = new Set(scan.sanitizers.map((s) => s.patternId));
    expect(sanitizerIds).toContain('ip-class-check');
    expect(sanitizerIds).toContain('host-allowlist');
    expect(sanitizerIds).toContain('scheme-check');

    // every candidate in the safe repo carries downranking evidence
    for (const candidate of scan.candidates) {
      expect(candidate.sanitizers.length).toBeGreaterThan(0);
    }
  });
});

describe('scanRepo determinism', () => {
  it('two scans of the same tree produce identical candidates', async () => {
    const [first, second] = await Promise.all([scanRepo(VULNERABLE), scanRepo(VULNERABLE)]);
    expect(first.candidates).toEqual(second.candidates);
  });
});
