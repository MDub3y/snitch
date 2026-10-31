/**
 * The Rust threat taxonomy — the knowledge the scanner reasons with. Each
 * category is a structured description of a Rust-specific failure mode: what
 * it is, the sinks that signal it, and what makes it genuinely exploitable.
 * This text is fed into the security system prompt, and the `id`s are the
 * allowed values for a finding's `category`, so the model's output stays
 * machine-usable.
 *
 * `phase1` marks the categories we invest in first (panic/DoS + injection):
 * highest signal, easiest to prove reachable.
 */

export interface ThreatCategory {
  id: string;
  title: string;
  /** Whether this is a Phase-1 priority category. */
  phase1: boolean;
  /** What the weakness is and why it matters in Rust specifically. */
  description: string;
  /** Concrete sinks / patterns that hint at the category (not proof on their own). */
  sinks: string[];
  /** What has to be true for it to be a real, exploitable issue. */
  exploitability: string;
}

export const TAXONOMY: readonly ThreatCategory[] = [
  {
    id: 'panic-dos',
    title: 'Panic → denial of service',
    phase1: true,
    description:
      'Rust aborts the current task/thread on panic. A panic reachable from a request handler or other untrusted entry point is a remote DoS. Overflowing arithmetic wraps silently in release builds and can feed a later panic or bad bounds check.',
    sinks: [
      'unwrap() / expect() / panic! / unreachable! / todo! / unimplemented! on values derived from input',
      'slice/array indexing a[i] and a[i..j] with attacker-influenced index or range',
      'integer division / remainder by a possibly-zero value',
      'arithmetic that can overflow feeding allocation, indexing, or a length/auth check',
      'Vec::with_capacity / reserve / allocations sized from an untrusted length field',
      'unbounded recursion or loops driven by untrusted structure (parsers, nested input)',
    ],
    exploitability:
      'Trace the panicking value back to an entry point. Reachable + attacker-controlled trigger = real DoS. A panic only on a developer invariant, or behind validation that already rejects the trigger, is not.',
  },
  {
    id: 'command-injection',
    title: 'OS command / argument injection',
    phase1: true,
    description:
      'Building a std::process::Command (or a crate wrapper) from untrusted data. Passing a string through a shell (sh -c / cmd /C) makes it classic shell injection; even without a shell, attacker-controlled argv or a chosen executable path is dangerous.',
    sinks: [
      'Command::new(x) where x is influenced by input',
      '.arg()/.args() built from untrusted strings, especially into sh -c / bash -c / cmd /C',
      'format!()-ing user data into a command line',
      'crates that shell out (duct, subprocess, run_script) fed untrusted data',
    ],
    exploitability:
      'Full control over the command or shell string = critical. Partial control (one arg, no shell) is lower unless it enables flag injection or path choice. Confirm the data truly reaches the sink unsanitised.',
  },
  {
    id: 'path-traversal',
    title: 'Path traversal / arbitrary file access',
    phase1: true,
    description:
      'Joining untrusted path components into filesystem operations. Path::join replaces the base entirely if the component is absolute, and ../ escapes the intended directory, so naive joins expose arbitrary read/write.',
    sinks: [
      'Path::join / PathBuf::push with an untrusted component',
      'fs::read / write / File::open / remove_file on a path built from input',
      'serving files from a web handler using a user-supplied name without canonicalise + prefix check',
    ],
    exploitability:
      'Reachable untrusted component with no canonicalisation or allow-list check = real. Verify there is no containment check (canonicalize + starts_with base) between source and sink.',
  },
  {
    id: 'sql-injection',
    title: 'SQL injection',
    phase1: true,
    description:
      'Building SQL by string concatenation instead of parameter binding. sqlx/diesel are safe when used with bound parameters, but raw query paths that interpolate user data are injectable.',
    sinks: [
      'format!()/push_str building a query string from input',
      'sqlx::query(&format!(...)) instead of query! / bind()',
      'diesel sql_query with interpolated data',
      'any raw-SQL execution where user data is concatenated, not bound',
    ],
    exploitability:
      'Untrusted data concatenated into executed SQL = injectable. Parameterised/bound queries are safe. Confirm the interpolated value is attacker-controlled and not a fixed/validated enum.',
  },
  {
    id: 'ssrf',
    title: 'Server-side request forgery',
    phase1: true,
    description:
      'An HTTP client fetching a URL (host, port, or path) derived from untrusted input, letting an attacker reach internal services or cloud metadata endpoints.',
    sinks: [
      'reqwest / hyper / ureq client calls with a user-supplied URL or host',
      'redirect-following clients on untrusted URLs',
      'webhook / callback / "fetch this URL" features',
    ],
    exploitability:
      'User controls the destination and there is no allow-list / internal-range block = real SSRF. A fixed base URL with only a path segment appended is lower risk.',
  },
  {
    id: 'unsafe-memory',
    title: 'Unsafe / memory-safety escape',
    phase1: false,
    description:
      'unsafe blocks opt out of Rust’s guarantees. Raw pointer and raw-slice construction, uninitialised memory and transmute can produce out-of-bounds access, use-after-free or type confusion when their invariants are driven by input.',
    sinks: [
      'slice::from_raw_parts(_mut) with a length/pointer influenced by input',
      'ptr::read/write/copy, get_unchecked(_mut), offset/add on raw pointers',
      'mem::transmute, mem::uninitialized, MaybeUninit::assume_init misuse',
      'hand-written unsafe impl Send/Sync',
    ],
    exploitability:
      'Judge the unsafe block’s invariants: can untrusted input violate them (e.g. control a length passed to from_raw_parts)? Reachable violation = memory-corruption primitive. Well-encapsulated unsafe with checked invariants is fine.',
  },
  {
    id: 'ffi-boundary',
    title: 'FFI boundary defect',
    phase1: false,
    description:
      'The C/Rust boundary loses Rust’s guarantees: NUL handling, buffer lengths, ownership and lifetimes must be upheld by hand across extern calls and #[no_mangle] exports.',
    sinks: [
      'CString/CStr round-trips of untrusted bytes (embedded NULs, missing terminator)',
      'passing Rust buffer + length to C where the length can be wrong',
      '#[no_mangle] / extern "C" exported functions taking raw pointers from callers',
    ],
    exploitability:
      'Mismatched length/ownership assumptions reachable with attacker data = corruption. Confirm the invariant is actually violable from input.',
  },
  {
    id: 'deserialization',
    title: 'Untrusted deserialization / resource exhaustion',
    phase1: false,
    description:
      'Deserializing untrusted data into types with surprising behaviour, or decompressing without limits, enabling type confusion, huge allocations or decompression bombs.',
    sinks: [
      'serde / bincode / rmp / ciborium decoding untrusted bytes into complex or externally-tagged types',
      'unbounded decompression (flate2 / zip / zstd) of untrusted input',
      'formats that allocate from a length prefix before validating it',
    ],
    exploitability:
      'Untrusted input decoded with no size/depth limit, or into a type whose Deserialize has side effects = real. Length-limited decoding into plain data types is low risk.',
  },
  {
    id: 'access-control',
    title: 'Broken access control / auth logic',
    phase1: false,
    description:
      'Web handlers (axum/actix-web/rocket/warp) missing authentication or authorization, or checking the wrong subject — IDOR, privilege escalation, missing ownership checks.',
    sinks: [
      'handlers that read an id from the path/query and fetch/mutate without an ownership check',
      'routes missing an auth extractor/middleware that siblings have',
      'role/permission checks that are absent, commented out, or check the wrong field',
    ],
    exploitability:
      'A state-changing or data-returning route reachable without the authz check its siblings enforce = real. Needs an entry point and a protected resource.',
  },
  {
    id: 'crypto-misuse',
    title: 'Weak crypto / secret handling',
    phase1: false,
    description:
      'Weak or misused cryptography and mishandled secrets: broken primitives, predictable randomness for security tokens, skipped verification, hardcoded keys.',
    sinks: [
      'md5 / sha1 for security purposes, ECB mode, static IV/nonce reuse',
      'rand (thread_rng) instead of a CSPRNG (OsRng) for tokens/keys/passwords',
      'hardcoded keys/passwords/secrets, secrets logged',
      'skipped TLS/cert verification (danger_accept_invalid_certs), unverified signatures/JWT',
    ],
    exploitability:
      'Judge the security relevance: predictable token an attacker can forge/guess, forgeable signature, interceptable connection = real. Non-security uses of a weak hash are info-level.',
  },
  {
    id: 'dependency',
    title: 'Vulnerable dependency (reachability-gated)',
    phase1: false,
    description:
      'A dependency with a known RustSec/CVE advisory. Only meaningful if the vulnerable API is actually called on a path from an entry point — the gate that separates us from plain version matching.',
    sinks: [
      'a crate+version in the dependency tree matching a RustSec advisory',
      'the advisory’s vulnerable function/feature actually invoked in this codebase',
    ],
    exploitability:
      'Advisory applies AND the vulnerable code path is reachable from this crate = real. Advisory on an unused code path or disabled feature = informational.',
  },
];

export const CATEGORY_IDS: readonly string[] = TAXONOMY.map((category) => category.id);

export function isKnownCategory(id: string): boolean {
  return CATEGORY_IDS.includes(id);
}

/** Renders the taxonomy for the system prompt, Phase-1 categories first. */
export function renderTaxonomy(): string {
  const ordered = [...TAXONOMY].sort((a, b) => Number(b.phase1) - Number(a.phase1));
  return ordered
    .map((category) => {
      const priority = category.phase1 ? ' [PRIORITY]' : '';
      const sinks = category.sinks.map((sink) => `    - ${sink}`).join('\n');
      return [
        `### ${category.id}${priority} — ${category.title}`,
        category.description,
        '  Signals (not proof on their own):',
        sinks,
        `  Exploitability test: ${category.exploitability}`,
      ].join('\n');
    })
    .join('\n\n');
}
