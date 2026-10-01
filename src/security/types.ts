export interface CodeLocation {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-based. */
  line: number;
  snippet: string;
}

export interface SourceHit {
  patternId: string;
  kind: 'extractor' | 'header' | 'field-name';
  location: CodeLocation;
  /** Enclosing fn name, when one could be determined. */
  enclosingFn?: string;
}

export interface SinkHit {
  patternId: string;
  crate: string;
  location: CodeLocation;
  enclosingFn?: string;
}

export interface SanitizerHit {
  patternId: string;
  location: CodeLocation;
}

export interface Span {
  file: string;
  startLine: number;
  endLine: number;
}

export interface Candidate {
  id: string;
  source: SourceHit;
  sink: SinkHit;
  /** Source and sink in the same file: the most direct shape. */
  sameFile: boolean;
  /** Sanitizer evidence found in the source or sink file — downranks, never auto-clears. */
  sanitizers: SanitizerHit[];
  /** The code the trace stage reads: enclosing-fn spans around source and sink. */
  slice: Span[];
}

export interface RepoScan {
  root: string;
  filesScanned: number;
  sources: SourceHit[];
  sinks: SinkHit[];
  sanitizers: SanitizerHit[];
  candidates: Candidate[];
}
