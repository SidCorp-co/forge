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
