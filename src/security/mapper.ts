import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { SANITIZERS, SINKS, SOURCES } from './knowledge.js';
import type { Candidate, RepoScan, SanitizerHit, SinkHit, SourceHit, Span } from './types.js';

/**
 * Stages 1-2 of the scan pipeline: map the repo and find sinks, entirely
 * deterministic (no LLM, no network). Reads .rs files, matches the knowledge
 * catalogs per line, and pairs sources with sinks into trace candidates.
 */

const FN_DECL = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/;

/** Strips `// ...` comments without eating `https://` inside strings. */
function stripComment(line: string): string {
  const at = line.search(/(^|\s)\/\//);
  return at === -1 ? line : line.slice(0, at);
}

interface FileText {
  file: string;
  lines: string[];
  raw: string;
}

function enclosingFn(lines: string[], lineIndex: number): { name: string; startLine: number } | undefined {
  for (let i = lineIndex; i >= 0; i--) {
    const match = FN_DECL.exec(lines[i]!);
    if (match) return { name: match[1]!, startLine: i + 1 };
  }
  return undefined;
}

/** Span of the enclosing fn via brace counting; falls back to a +/-25 line window. */
function sliceSpan(lines: string[], lineIndex: number): { startLine: number; endLine: number } {
  const fn = enclosingFn(lines, lineIndex);
  if (fn) {
    let depth = 0;
    let opened = false;
    for (let i = fn.startLine - 1; i < lines.length; i++) {
      for (const ch of stripComment(lines[i]!)) {
        if (ch === '{') {
          depth++;
          opened = true;
        } else if (ch === '}') depth--;
      }
      if (opened && depth <= 0) return { startLine: fn.startLine, endLine: i + 1 };
    }
  }
  return { startLine: Math.max(1, lineIndex + 1 - 25), endLine: Math.min(lines.length, lineIndex + 1 + 25) };
}

function scanFile(text: FileText): { sources: SourceHit[]; sinks: SinkHit[]; sanitizers: SanitizerHit[] } {
  const sources: SourceHit[] = [];
  const sinks: SinkHit[] = [];
  const sanitizers: SanitizerHit[] = [];

  text.lines.forEach((rawLine, index) => {
    const line = stripComment(rawLine);
    if (!line.trim()) return;
    const location = { file: text.file, line: index + 1, snippet: rawLine.trim() };
    const fn = enclosingFn(text.lines, index)?.name;

    for (const sink of SINKS) {
      if (sink.requiresUse && !sink.requiresUse.test(text.raw)) continue;
      if (sink.pattern.test(line)) {
        sinks.push({ patternId: sink.id, crate: sink.crate, location, ...(fn ? { enclosingFn: fn } : {}) });
      }
    }
    for (const source of SOURCES) {
      if (source.requiresUse && !source.requiresUse.test(text.raw)) continue;
      if (source.pattern.test(line)) {
        sources.push({ patternId: source.id, kind: source.kind, location, ...(fn ? { enclosingFn: fn } : {}) });
      }
    }
    for (const sanitizer of SANITIZERS) {
      if (sanitizer.pattern.test(line)) sanitizers.push({ patternId: sanitizer.id, location });
    }
  });

  return { sources, sinks, sanitizers };
}

function mergeSpans(spans: Span[]): Span[] {
  const byFile = new Map<string, Span[]>();
  for (const span of spans) {
    const list = byFile.get(span.file) ?? [];
    list.push(span);
    byFile.set(span.file, list);
  }
  const out: Span[] = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.startLine - b.startLine);
    let current = { ...list[0]!, file };
    for (const span of list.slice(1)) {
      if (span.startLine <= current.endLine + 1) current.endLine = Math.max(current.endLine, span.endLine);
      else {
        out.push(current);
        current = { ...span };
      }
    }
    out.push(current);
  }
  return out;
}

/**
 * Pairing heuristic (v1, deterministic):
 * - same file: every source pairs with every sink in that file;
 * - cross-file: a sink pairs with a source from another file when the source's
 *   file references the sink's enclosing function by name (a call-shaped
 *   mention, e.g. `forward(`), approximating one hop of reachability.
 */
function pairCandidates(files: Map<string, FileText>, sources: SourceHit[], sinks: SinkHit[], sanitizers: SanitizerHit[]): Candidate[] {
  const candidates: Candidate[] = [];

  for (const source of sources) {
    for (const sink of sinks) {
      const sameFile = source.location.file === sink.location.file;
      let linked = sameFile;
      if (!sameFile && sink.enclosingFn) {
        const sourceText = files.get(source.location.file)!;
        linked = new RegExp(`(^|[^\\w])${sink.enclosingFn}\\s*\\(`).test(
          sourceText.lines.map(stripComment).join('\n'),
        );
      }
      if (!linked) continue;

      const sourceLines = files.get(source.location.file)!.lines;
      const sinkLines = files.get(sink.location.file)!.lines;
      const slice = mergeSpans([
        { file: source.location.file, ...sliceSpan(sourceLines, source.location.line - 1) },
        { file: sink.location.file, ...sliceSpan(sinkLines, sink.location.line - 1) },
      ]);
      const relevantSanitizers = sanitizers.filter(
        (s) => s.location.file === source.location.file || s.location.file === sink.location.file,
      );

      candidates.push({
        id: `${source.patternId}@${source.location.file}:${source.location.line}->${sink.patternId}@${sink.location.file}:${sink.location.line}`,
        source,
        sink,
        sameFile,
        sanitizers: relevantSanitizers,
        slice,
      });
    }
  }
  return candidates;
}

export async function scanRepo(root: string): Promise<RepoScan> {
  const paths = await glob('**/*.rs', {
    cwd: root,
    ignore: ['target/**', '.git/**', 'node_modules/**'],
  });
  paths.sort(); // deterministic output order regardless of filesystem order

  const files = new Map<string, FileText>();
  for (const relative of paths) {
    const file = relative.replaceAll('\\', '/');
    const raw = await fs.readFile(path.join(root, relative), 'utf8');
    files.set(file, { file, lines: raw.split(/\r?\n/), raw });
  }

  const sources: SourceHit[] = [];
  const sinks: SinkHit[] = [];
  const sanitizers: SanitizerHit[] = [];
  for (const text of files.values()) {
    const hits = scanFile(text);
    sources.push(...hits.sources);
    sinks.push(...hits.sinks);
    sanitizers.push(...hits.sanitizers);
  }

  return {
    root,
    filesScanned: files.size,
    sources,
    sinks,
    sanitizers,
    candidates: pairCandidates(files, sources, sinks, sanitizers),
  };
}
