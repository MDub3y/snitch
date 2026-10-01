/**
 * The deterministic SSRF knowledge for Rust HTTP servers: what stages 1-2 of
 * the scan pipeline grep for. Patterns run per line (comments stripped);
 * `requiresUse` gates noisy method-call patterns on the crate actually being
 * imported in the file.
 */

export interface SinkPattern {
  id: string;
  crate: string;
  pattern: RegExp;
  /** Only match in files whose text matches this (e.g. `use reqwest`). */
  requiresUse?: RegExp;
  description: string;
}

export interface SourcePattern {
  id: string;
  kind: 'extractor' | 'header' | 'field-name';
  pattern: RegExp;
  requiresUse?: RegExp;
  description: string;
}

export interface SanitizerPattern {
  id: string;
  pattern: RegExp;
  description: string;
}

/** Outbound-request call sites. */
export const SINKS: SinkPattern[] = [
  {
    id: 'reqwest-free-fn',
    crate: 'reqwest',
    pattern: /\breqwest::get\s*\(/,
    description: 'reqwest::get with a caller-supplied URL',
  },
  {
    id: 'reqwest-client-method',
    crate: 'reqwest',
    pattern: /\b\w*client\w*\s*\.\s*(get|post|put|delete|head|patch|request)\s*\(/i,
    requiresUse: /\breqwest\b/,
    description: 'reqwest Client HTTP method call',
  },
  {
    id: 'hyper-client',
    crate: 'hyper',
    pattern: /\b\w*client\w*\s*\.\s*request\s*\(|\bhyper::Client\b/,
    requiresUse: /\bhyper\b/,
    description: 'hyper client request',
  },
  {
    id: 'ureq-call',
    crate: 'ureq',
    pattern: /\bureq::(get|post|put|delete|head|request)\s*\(/,
    description: 'ureq HTTP call',
  },
  {
    id: 'isahc-call',
    crate: 'isahc',
    pattern: /\bisahc::(get|post|put|send|get_async|post_async|send_async)\b/,
    description: 'isahc HTTP call',
  },
  {
    id: 'surf-call',
    crate: 'surf',
    pattern: /\bsurf::(get|post|put|delete)\s*\(/,
    description: 'surf HTTP call',
  },
  {
    id: 'tcp-connect',
    crate: 'std',
    pattern: /\bTcpStream::connect(_timeout)?\s*\(/,
    description: 'raw TcpStream::connect',
  },
];

/** Where external input enters a handler. */
export const SOURCES: SourcePattern[] = [
  {
    id: 'axum-extractor',
    kind: 'extractor',
    pattern: /\b(Path|Query|Json|Form)\s*[(<]/,
    requiresUse: /\baxum\b/,
    description: 'axum Path/Query/Json/Form extractor',
  },
  {
    id: 'actix-extractor',
    kind: 'extractor',
    pattern: /\bweb::(Path|Query|Json|Form)\b/,
    requiresUse: /\bactix_web\b/,
    description: 'actix-web extractor',
  },
  {
    id: 'header-read',
    kind: 'header',
    pattern: /\.headers\s*\(\)|\bHeaderMap\b/,
    description: 'request header access',
  },
  {
    id: 'url-ish-field',
    kind: 'field-name',
    pattern: /\b\w*(url|uri|webhook|callback|endpoint|href|avatar)\w*\s*:\s*(Option\s*<\s*)?(String|&\s*str|Cow)/i,
    description: 'struct field or parameter named like a URL',
  },
];

/** Evidence of validation on the path — downranks a candidate, never clears it. */
export const SANITIZERS: SanitizerPattern[] = [
  {
    id: 'ip-class-check',
    pattern: /\.is_private\s*\(\)|\.is_loopback\s*\(\)|\.is_link_local\s*\(\)/,
    description: 'private/loopback/link-local check on a resolved IP',
  },
  {
    id: 'host-allowlist',
    pattern: /\ballow(ed)?_?(list|_?hosts|_?domains)\b|\bwhitelist\b/i,
    description: 'host allowlist',
  },
  {
    id: 'scheme-check',
    pattern: /\.scheme\s*\(\)\s*(==|!=)|starts_with\s*\(\s*"https?:/,
    description: 'URL scheme restriction',
  },
];
