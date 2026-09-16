// Where an integration provider's NAME is allowed to be written down.
//
// ISS-1071's rule is that one declaration describes a provider and every generic
// path asks the registry instead of naming it. A `provider === 'coolify'` in a
// status card, a `['epodsystem','postman','sentry']` in an MCP resolver and a
// per-provider branch in a web drawer are all the same defect wearing three
// shapes: adding the eighth provider means editing all of them, and forgetting
// one is silent — the generic path keeps working for the seven it knows.
//
// A type cannot hold this. `IntegrationProvider` makes `'coolify'` legal
// EVERYWHERE the union is in scope, which is the whole point of the union; what
// is wrong is not the value but the place. So the rule is about location, and
// the check is a scan.
//
// ## The two bounds this scan has, stated rather than discovered later
//
// 1. It matches a literal whose WHOLE content is the provider name, case
//    sensitively. `'Coolify'` is a display label and `'coolify: healthcheck
//    failed'` is a log line; neither dispatches on anything. Measured across the
//    three scan roots on 2026-09-17: the exact rule named 70 files, and widening
//    it to "the name appears as a word anywhere in the literal" added 51 more —
//    `"Continue with GitHub"`, `"next/font/google"`, `"@/lib/sentry"`,
//    `"coolify.confirm"` span names and every `<provider>-section.tsx` label.
//    That is the shape `check-pat-surface`'s own guard names as worse than no
//    checker: at 95% noise a reader learns to skip the report.
//    What the bound costs: `startsWith('epodsystem_')` is a provider name and
//    this rule does not see it. It is a real hole and it is priced here rather
//    than papered over — every file carrying such a prefix today also carries
//    the bare value, so nothing is currently hidden by it.
// 2. Quotes inside a regex literal are not distinguished from a string, because
//    telling `/['"]/` from division needs a parser. The scan aborts a quoted run
//    that reaches a newline unclosed and resumes at the next character, so the
//    damage is bounded to one line and shows up as a missed literal, never as an
//    invented one.

// cm:guard the tokenizer skips comments BEFORE matching, and that is load-bearing rather than
// tidy: this repo's `cm:guard` and `cm:why` prose quotes the very literals the rule forbids —
// `registry.ts` explains the retired `startsWith('epodsystem_')` gate by writing it out — and a
// scan that accused its own documentation would be uninhabitable within a week.
/**
 * Every quoted string literal in a TypeScript source, comments excluded.
 *
 * A template literal contributes one entry per static chunk, split at each `${`, so
 * `` `epodsystem_${label}` `` yields `epodsystem_` and the substitution is scanned as code.
 *
 * @returns {Array<{ value: string, line: number }>}
 */
export function stringLiterals(text) {
  const out = [];
  /** One frame per template literal we are inside. `chunk` is non-null in its literal part. */
  const frames = [];
  let line = 1;
  let i = 0;

  const top = () => frames[frames.length - 1];

  while (i < text.length) {
    const frame = top();
    const c = text[i];
    const d = text[i + 1];

    if (frame?.chunk) {
      if (c === '\\') {
        if (text[i + 1] === '\n') line++;
        frame.chunk.value += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '`') {
        out.push(frame.chunk);
        frames.pop();
        i++;
        continue;
      }
      if (c === '$' && d === '{') {
        out.push(frame.chunk);
        frame.chunk = null;
        frame.braces = 0;
        i += 2;
        continue;
      }
      if (c === '\n') line++;
      frame.chunk.value += c;
      i++;
      continue;
    }

    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let k = i; k < stop; k++) if (text[k] === '\n') line++;
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      const quoted = readQuoted(text, i, c);
      if (quoted === null) {
        // cm:guard an unterminated run is NOT emitted and advances exactly one character. That is
        // what keeps a regex literal's own quote from swallowing the rest of the file: the scan
        // realigns at the next newline instead of reading code as string.
        i++;
        continue;
      }
      out.push({ value: quoted.value, line });
      i = quoted.end;
      continue;
    }
    if (c === '`') {
      frames.push({ chunk: { value: '', line }, braces: 0 });
      i++;
      continue;
    }
    if (frame && frame.chunk === null) {
      if (c === '{') {
        frame.braces++;
        i++;
        continue;
      }
      if (c === '}') {
        if (frame.braces === 0) frame.chunk = { value: '', line };
        else frame.braces--;
        i++;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** @returns `{value, end}` for a run closed on its own line, or null when it is not closed there. */
function readQuoted(text, start, quote) {
  let value = '';
  let j = start + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      value += text[j + 1] ?? '';
      j += 2;
      continue;
    }
    if (ch === '\n') return null;
    if (ch === quote) return { value, end: j + 1 };
    value += ch;
    j++;
  }
  return null;
}

// cm:guard `**` spans path separators and a single `*` does not, which is the difference between
// `packages/core/src/db/**` (a subtree, and what the manifest means) and `packages/*/src`. Every
// other character is escaped, so a glob carrying a `.` matches a dot and not any character — a
// pattern language that quietly accepted regex metacharacters would let one allowlist entry admit
// far more than its author read.
/** A repo-relative glob supporting `*` and `**`, anchored at both ends. */
export function globToRegExp(glob) {
  const body = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${body}$`);
}

/** True when `path` sits under one of the declared allowed locations. */
export function isAllowed(path, allowed) {
  return allowed.some((entry) => globToRegExp(entry.glob).test(path));
}

// cm:guard an entry with no `why` is a CONFIG fault and exits 2, never a silently honoured
// exemption. An allowlist is where a rule goes to die quietly: each line removes a subtree from
// the scan, and a line nobody can read the reason for is one nobody can retire either. The
// requirement is ISS-1071's own acceptance criterion — each declared allowed location carries the
// reason it is allowed — so it is enforced here rather than reviewed by eye.
/** @returns one sentence per malformed `allowed` entry; empty when the list is well formed. */
export function allowedFaults(allowed) {
  if (!Array.isArray(allowed)) return ['checkers.provider-literals.allowed is not an array'];
  const faults = [];
  allowed.forEach((entry, index) => {
    const glob = typeof entry?.glob === 'string' ? entry.glob : null;
    if (!glob) {
      faults.push(`entry ${index} declares no \`glob\` string`);
      return;
    }
    if (typeof entry.why !== 'string' || entry.why.trim() === '') {
      faults.push(`${glob} carries no \`why\` — say what makes naming a provider correct there`);
    }
  });
  return faults;
}

// cm:guard this is what stops a provider leaving the scan by being forgotten. `agent` is out of
// the scanned set on purpose and says so in `unscannable`; the difference between that and a
// provider quietly dropped from `providers` is exactly this function. Every name the code declares
// must appear in one list or the other, and an eighth provider added to the union with neither
// entry takes the checker to exit 2 rather than to a smaller scan nobody notices.
/** @returns one sentence per declared provider that is in neither the scanned nor the excused set. */
export function coverageFaults(declared, providers, unscannable) {
  const excused = new Set((unscannable ?? []).map((u) => u?.provider));
  const scanned = new Set(providers ?? []);
  const faults = [];
  for (const name of declared) {
    if (scanned.has(name) || excused.has(name)) continue;
    faults.push(
      `${name} is declared in INTEGRATION_PROVIDERS and appears in neither ` +
        'checkers.provider-literals.providers nor its `unscannable` list',
    );
  }
  for (const u of unscannable ?? []) {
    if (typeof u?.why !== 'string' || u.why.trim() === '') {
      faults.push(`unscannable entry ${u?.provider ?? '(unnamed)'} carries no \`why\``);
    }
  }
  return faults;
}

/**
 * The offenders in a set of already-read sources.
 *
 * @param entries `[{path, text}]`, repo-relative paths.
 * @param config `{providers, allowed}` as the manifest declares them.
 * @returns `{scanned, offenders: Array<{path, line, provider}>}`
 */
export function scanEntries(entries, { providers, allowed }) {
  const names = new Set(providers);
  const offenders = [];
  let scanned = 0;
  for (const { path, text } of entries) {
    scanned += 1;
    if (isAllowed(path, allowed)) continue;
    for (const { value, line } of stringLiterals(text)) {
      if (names.has(value)) offenders.push({ path, line, provider: value });
    }
  }
  return { scanned, offenders };
}

/** The offenders grouped by file, each file's providers deduplicated and sorted. */
export function byFile(offenders) {
  const files = new Map();
  for (const o of offenders) {
    if (!files.has(o.path)) files.set(o.path, { providers: new Set(), lines: [] });
    files.get(o.path).providers.add(o.provider);
    files.get(o.path).lines.push(o.line);
  }
  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, v]) => ({
      path,
      providers: [...v.providers].sort(),
      lines: [...new Set(v.lines)].sort((a, b) => a - b),
    }));
}
