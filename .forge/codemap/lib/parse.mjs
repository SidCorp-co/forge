// @generated codemap 0.13.0 — vendored by `cm install`; edit the plugin, not this.
// codemap/1 §3 §4 §7 — grammar, canonical form, diagnostics.

export const TAGS = ['flow', 'edge', 'guard', 'hack', 'why'];

// cm:why the whole prose family is baselined together, so `cm init` leaves a legacy repo green (§8)
export const PROSE_CODES = new Set(['CM001', 'CM010', 'CM011']);

/**
 * Baseline key for one prose comment: a hash of its normalized text.
 *
 * Counting comments per file was the first design and it failed on contact — adding three lines to
 * a file with eighty frozen comments surfaced all eighty, because a count cannot say WHICH comment
 * is new. Hashing the text can: it is line-independent (reformatting and moving code are free),
 * deleting legacy comments is free, and only genuinely new text is flagged.
 */
export function baselineKey(text) {
  const norm = String(text).replace(/\s+/g, ' ').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
export const EDGE_KINDS = ['contract', 'ordering', 'lockstep', 'sideeffect', 'naming', 'protocol'];

/** codemap/1 §4 — the single recognizer. */
export const CM_LINE_RE = /^\s*(\/\/|#|--)\s*cm:([a-z][a-z-]*)\b/;
const CM_TEXT_RE = /^cm:([a-z][a-z-]*)\b\s*(.*)$/s;
const IGNORE_RE = /^cm:ignore\s+(CM\d{3})\s*(?:—|--|-)\s*(\S.*)$/;
// cm:why marker-shaped only — a bare \bXXX\b matched "TC-XXX" in real repos, and a validator that cries wolf gets switched off
const TODO_RE = /^(TODO|FIXME|HACK)\b|\b(TODO|FIXME)\s*[:(]/;
const ID = '[a-z0-9][a-z0-9-]*';

const CODES = {
  CM001: { tier: 'grammar', section: '§1.1', message: 'prose comment is not allowed here', fix: 'if it records something the compiler, the types, the path and the LSP cannot state, keep it as cm:why (rationale) or cm:guard (something whoever edits this must know); if it restates the code, delete it' },
  CM002: { tier: 'grammar', section: '§3', message: 'unknown cm: tag', fix: `use one of: ${TAGS.join(', ')}` },
  CM003: { tier: 'grammar', section: '§4', message: 'cm: annotation inside a block or doc comment', fix: 'move it to a line comment — block/doc comments are parsed by TSDoc, PHPStan, Psalm and rustdoc' },
  CM004: { tier: 'grammar', section: '§5', message: 'cm:edge needs a known kind', fix: `kind must be one of: ${EDGE_KINDS.join(', ')}` },
  CM005: { tier: 'grammar', section: '§4', message: 'cm:edge needs "-> <repo-relative-target>"', fix: 'write: cm:edge <kind> -> path/to/file.ts[#symbol] — <why they are coupled>; if this is rationale rather than a coupling, use cm:why' },
  CM006: { tier: 'grammar', section: '§4', message: 'cm:flow needs "<flow>/<step>"', fix: 'write: cm:flow <flow>/<step> [after:<step>] — <what this step does>' },
  CM007: { tier: 'grammar', section: '§4', message: 'cm:hack needs "ISS-<n> until:<condition> — <text>"', fix: 'a workaround without an exit condition is permanent; name the issue and what would remove it' },
  CM008: { tier: 'grammar', section: '§4', message: 'annotation body is empty', fix: 'say the one thing that is not derivable, or delete the annotation' },
  CM009: { tier: 'grammar', section: '§4', message: 'annotation is not in canonical form', fix: 'run: cm fmt' },
  CM010: { tier: 'grammar', section: '§3', message: 'new TODO/FIXME introduced', fix: 'the tracker owns outstanding work — file an issue at draft status; use cm:hack ISS-<n> until:<cond> only for a workaround that is in the code right now' },
  CM011: { tier: 'grammar', section: '§4.1', message: 'module header is too long', fix: 'a header orients a reader in a few lines; move the rest to docs/ and leave a pointer' },
  CM012: { tier: 'grammar', section: '§4', message: 'cm:edge target is followed by prose with no " — "', fix: 'put " — " before the rationale: cm:edge <kind> -> <target> — <why they are coupled>' },
  CM101: { tier: 'referential', section: '§8', message: 'flow is not declared in the registry', fix: 'run: cm new flow <name> (closed vocabulary keeps typos from forking the graph)' },
  CM102: { tier: 'referential', section: '§4', message: 'cm:edge target does not exist', fix: 'fix the path, or if the target moved, update the edge — a dangling edge is drift, not documentation' },
  CM103: { tier: 'referential', section: '§4', message: 'after: names a step that does not exist', fix: 'point at a real <step> of the same flow' },
  CM105: { tier: 'referential', section: '§4', message: 'duplicate <flow>/<step> id', fix: 'one step id per flow — rename one of them' },
  CM106: { tier: 'referential', section: '§4', message: 'cm:edge #symbol is not in the target file', fix: 'the symbol was renamed or moved — update the anchor, or drop it and point the edge at the file' },
  CM107: { tier: 'referential', section: '§8', message: 'external is not declared in the registry', fix: 'run: cm new external <name> — an out-of-tree target is verifiable only as far as its name, so the name at least is closed vocabulary' },
  CM302: { tier: 'advisory', section: '§7.1', message: 'annotation text is prose the baseline already froze', fix: 'a tag is not a fix for CM001 — delete the sentence, or rewrite it to say the thing that is NOT derivable; if the words really are the invariant, reword them so they read as one' },
  CM301: { tier: 'advisory', section: '§7.1', message: 'declared coupling has no evidence at the other end', fix: 'check the other side is really wired — if the coupling is real but reference-free (HTTP, SQL, a cron), say so with: cm:ignore CM301 — <why there is no reference>' },
  CM201: { tier: 'structural', section: '§7', message: 'flow has a single step', fix: 'either the remaining steps are unannotated, or this is not a flow' },
  CM202: { tier: 'structural', section: '§7', message: 'after: chain is cyclic or the flow has several roots', fix: 'exactly one step may omit after:' },
};

export function diag(code, file, line, detail) {
  const c = CODES[code];
  return { code, tier: c.tier, section: c.section, file, line, message: detail ? `${c.message}: ${detail}` : c.message, fix: c.fix };
}

export const CODE_TABLE = CODES;

function splitProse(s) {
  const m = /\s(?:—|--|-)\s/.exec(s);
  if (!m) return [s.trim(), ''];
  return [s.slice(0, m.index).trim(), s.slice(m.index + m[0].length).trim()];
}

/**
 * Parse one comment's text as an annotation.
 * @returns {{ann}|{diags}|null} null when the text is not a cm: annotation at all.
 */
export function parseAnnotation(text, file, line) {
  const ig = IGNORE_RE.exec(text);
  if (ig) return { ignore: { code: ig[1], reason: ig[2] }, };
  if (/^cm:ignore\b/.test(text)) {
    return { diags: [diag('CM008', file, line, 'cm:ignore needs "<CODE> — <reason>"')] };
  }

  const m = CM_TEXT_RE.exec(text);
  if (!m) return null;
  const [, tag, bodyRaw] = m;
  const body = bodyRaw.trim();

  if (!TAGS.includes(tag)) return { diags: [diag('CM002', file, line, `cm:${tag}`)] };
  if (!body) return { diags: [diag('CM008', file, line, `cm:${tag}`)] };

  const base = { tag, file, line, raw: text };

  if (tag === 'flow') {
    const fm = new RegExp(`^(${ID})/(${ID})((?:\\s+\\S+)*)$`).exec(splitProse(body)[0]);
    if (!fm) return { diags: [diag('CM006', file, line, body)] };
    const [, flow, step, restRaw] = fm;
    const text2 = splitProse(body)[1];
    let after = null;
    for (const tok of restRaw.trim().split(/\s+/).filter(Boolean)) {
      const am = new RegExp(`^after:(${ID})$`).exec(tok);
      if (!am) return { diags: [diag('CM006', file, line, `unexpected token "${tok}"`)] };
      after = am[1];
    }
    return { ann: { ...base, flow, step, after, text: text2 } };
  }

  if (tag === 'edge') {
    const [head, prose] = splitProse(body);
    const em = /^(\S+)\s*->\s*(\S+)$/.exec(head);
    if (!em) {
      // cm:why one CM005 covered three authoring mistakes: for a valid kind and target with the separator
      //   forgotten it named the "->" that was already right, sending the author to fix that (ISS-6)
      const unseparated = !prose && /^\S+\s*->\s*\S+\s+\S/.test(head);
      return { diags: [diag(unseparated ? 'CM012' : 'CM005', file, line, body)] };
    }
    const [, kind, target] = em;
    if (!EDGE_KINDS.includes(kind)) return { diags: [diag('CM004', file, line, kind)] };
    // cm:why a migration repo's commonest cross-system contract is to a codebase that is not in the tree
    //   at all, so it was the one coupling codemap could not carry — 354 such comments in one repo (ISS-11)
    if (/^external:/.test(target)) {
      const xm = /^external:([a-z0-9][a-z0-9-]*)\/(\S+)$/.exec(target);
      if (!xm) {
        const d = diag('CM005', file, line, `"${target}" must be external:<name>/<path-inside-it>`);
        return { diags: [{ ...d, fix: 'write: cm:edge <kind> -> external:<name>/<path/inside/it> — <why>; the <name> is lower-case and declared with: cm new external <name>' }] };
      }
      return { ann: { ...base, kind, target, external: xm[1], text: prose } };
    }
    if (/^(\/|[a-z]+:\/\/|~)/.test(target)) {
      return { diags: [diag('CM005', file, line, `"${target}" must be repo-relative`)] };
    }
    // cm:why source-relative targets were accepted here and resolved from the root, so they failed as a
    //   referential CM102 in CI instead of at the keystroke — and 38 of them took that tier down (ISS-5)
    if (/^\.\.?\//.test(target)) {
      const d = diag('CM005', file, line, `"${target}" resolves from the repo root, not from this file`);
      return { diags: [{ ...d, fix: `${d.fix}; cm fmt rewrites a ../ target that resolves`, relative: { kind, target, text: prose } }] };
    }
    return { ann: { ...base, kind, target, text: prose } };
  }

  if (tag === 'hack') {
    const hm = /^ISS-(\d+)\s+until:(.+?)\s+(?:—|--|-)\s+(\S.*)$/.exec(body);
    if (!hm) return { diags: [diag('CM007', file, line, body)] };
    return { ann: { ...base, issue: `ISS-${hm[1]}`, until: hm[2].trim(), text: hm[3].trim() } };
  }

  return { ann: { ...base, text: body } };
}

/** codemap/1 §4 — canonical rendering. cm fmt rewrites to exactly this. */
export function canonical(ann) {
  switch (ann.tag) {
    case 'flow':
      return `cm:flow ${ann.flow}/${ann.step}${ann.after ? ` after:${ann.after}` : ''}${ann.text ? ` — ${ann.text}` : ''}`;
    case 'edge':
      return `cm:edge ${ann.kind} -> ${ann.target}${ann.text ? ` — ${ann.text}` : ''}`;
    case 'hack':
      return `cm:hack ${ann.issue} until:${ann.until} — ${ann.text}`;
    default:
      return `cm:${ann.tag} ${ann.text}`;
  }
}

export function hasTodo(text) {
  return TODO_RE.test(text) && !/^cm:/.test(text);
}
