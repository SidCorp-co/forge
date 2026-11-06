// The paths whose change reaches its direct core integration tests without `--integration`
// (ISS-1061): a migration, the schema, a permission or token fence, the issue machine and the
// kernel rules `packages/contracts/src/gate-profiles.ts:KERNEL_RULES` names. A red there found only
// at the batch's merge check is found after other builders stacked work on it, so the developer's
// run widens by this declared list rather than by a flag someone has to remember.
//
// The list is `.forge/high-impact-paths.json`: `{ "$why": "...", "paths": [{ "pattern", "reason" }] }`.
// A pattern is repo-relative with `*` (inside one segment) and `**` (across segments), read by
// `gate.mjs:globToRegExp`. An entry matching no tracked file is refused by name, as is a malformed
// one or one with no reason: a stale entry widens nothing and says nothing, which is a silence.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitOut, globToRegExp } from './gate.mjs';

export const HIGH_IMPACT_FILE = '.forge/high-impact-paths.json';

const SHAPE =
  `it must read \`{ "$why": "<why the list exists>", "paths": [{ "pattern": "<repo-relative glob>", ` +
  '"reason": "<what a red there costs>" }] }`';

/** What is wrong with one pattern's spelling, or null where it is a pattern this list reads. */
function patternFault(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') return 'has no pattern';
  if (pattern !== pattern.trim()) return `pattern "${pattern}" carries surrounding whitespace`;
  if (pattern.startsWith('/') || pattern.startsWith('./'))
    return `pattern "${pattern}" is not repo-relative (no leading "/" or "./")`;
  if (pattern.split('/').includes('..')) return `pattern "${pattern}" climbs out with ".."`;
  if (pattern.includes('\\')) return `pattern "${pattern}" uses "\\"; paths here are "/"-separated`;
  const unread = pattern.match(/[?[\]{}!]/);
  if (unread)
    return `pattern "${pattern}" uses "${unread[0]}", which this list does not read; it takes "*" and "**" only`;
  return null;
}

/**
 * The list's entries held to `tracked` (every path git tracks), or a refusal naming each fault:
 * HIGH_IMPACT_LIST_MALFORMED for the document, HIGH_IMPACT_ENTRY_MALFORMED for an entry's shape or
 * pattern, HIGH_IMPACT_REASON_MISSING for an entry with no reason, HIGH_IMPACT_ENTRY_STALE for a
 * pattern no tracked file matches. Every fault is named at once, never only the first.
 *
 * @param {string} text the file's contents
 * @param {Iterable<string>} tracked repo-relative tracked paths
 * @returns {{ entries: { pattern: string, reason: string, re: RegExp }[] } | { refusal: string }}
 */
export function parseHighImpactPaths(text, tracked) {
  const refuse = (faults) => ({
    refusal:
      `${HIGH_IMPACT_FILE} is refused, so nothing can say whether this change is high-impact:\n` +
      `${faults.map((f) => `  ${f}`).join('\n')}\n${SHAPE}.`,
  });
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return refuse([`HIGH_IMPACT_LIST_MALFORMED: not JSON (${e.message})`]);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc))
    return refuse(['HIGH_IMPACT_LIST_MALFORMED: the document is not an object']);
  const extra = Object.keys(doc).filter((k) => k !== '$why' && k !== 'paths');
  const faults = [];
  if (extra.length)
    faults.push(
      `HIGH_IMPACT_LIST_MALFORMED: unknown key(s) ${extra.map((k) => `"${k}"`).join(', ')}`,
    );
  if ('$why' in doc && (typeof doc.$why !== 'string' || doc.$why.trim() === ''))
    faults.push('HIGH_IMPACT_LIST_MALFORMED: "$why" is not a sentence');
  if (!Array.isArray(doc.paths) || doc.paths.length === 0) {
    faults.push('HIGH_IMPACT_LIST_MALFORMED: "paths" is not a non-empty list');
    return refuse(faults);
  }
  const files = [...tracked];
  const seen = new Set();
  const entries = [];
  doc.paths.forEach((entry, i) => {
    const at = `paths[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      faults.push(`HIGH_IMPACT_ENTRY_MALFORMED: ${at} is not { "pattern", "reason" }`);
      return;
    }
    const named = typeof entry.pattern === 'string' ? `${at} "${entry.pattern}"` : at;
    const unknown = Object.keys(entry).filter((k) => k !== 'pattern' && k !== 'reason');
    if (unknown.length)
      faults.push(
        `HIGH_IMPACT_ENTRY_MALFORMED: ${named} carries unknown key(s) ${unknown.map((k) => `"${k}"`).join(', ')}`,
      );
    const fault = patternFault(entry.pattern);
    if (fault) faults.push(`HIGH_IMPACT_ENTRY_MALFORMED: ${at} ${fault}`);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '')
      faults.push(`HIGH_IMPACT_REASON_MISSING: ${named} gives no reason`);
    if (fault) return;
    if (seen.has(entry.pattern)) {
      faults.push(`HIGH_IMPACT_ENTRY_MALFORMED: ${named} is listed twice`);
      return;
    }
    seen.add(entry.pattern);
    const re = globToRegExp(entry.pattern);
    if (!files.some((f) => re.test(f)))
      faults.push(
        `HIGH_IMPACT_ENTRY_STALE: ${named} matches no tracked file; correct it to the path that now holds what it guards, or remove it`,
      );
    entries.push({ pattern: entry.pattern, reason: entry.reason, re });
  });
  return faults.length ? refuse(faults) : { entries };
}

/**
 * This checkout's list, held to the files git tracks here. A missing file is refused
 * (HIGH_IMPACT_LIST_MISSING): without it nothing widens and nothing says so. `unreadable` marks the
 * one refusal that is not the list's fault: git could not say what it tracks.
 */
export function readHighImpactPaths(root) {
  let text;
  try {
    text = readFileSync(join(root, HIGH_IMPACT_FILE), 'utf8');
  } catch (e) {
    return {
      refusal: `HIGH_IMPACT_LIST_MISSING: ${HIGH_IMPACT_FILE} could not be read (${e.code ?? e.message}); ${SHAPE}.`,
    };
  }
  const tracked = gitOut(['ls-files'], root);
  if (tracked === null)
    return {
      refusal: `git ls-files failed, so ${HIGH_IMPACT_FILE} cannot be held to the tree`,
      unreadable: true,
    };
  return parseHighImpactPaths(text, tracked.split('\n').filter(Boolean));
}

/**
 * Each touched path a listed pattern matches, with the first entry matching it: the paths that
 * widen this run to its direct integration tests. A removed path widens as a changed one does.
 *
 * @param {string[]} touched repo-relative paths
 * @param {{ pattern: string, reason: string, re: RegExp }[]} entries
 */
export function widenedBy(touched, entries) {
  return touched.flatMap((path) => {
    const hit = entries.find((e) => e.re.test(path));
    return hit ? [{ path, pattern: hit.pattern, reason: hit.reason }] : [];
  });
}

/** The lines a run prints for what widened it, one per touched path, its pattern and its reason. */
export function describeWidening(widening, { flagged }) {
  if (widening.length === 0) return [];
  const head = flagged
    ? `test-changed: --integration was passed; these touched high-impact paths (${HIGH_IMPACT_FILE}) would have widened the run without it:`
    : `test-changed: the direct core integration tests run with no --integration, because this change touches high-impact paths (${HIGH_IMPACT_FILE}):`;
  return [head, ...widening.map((w) => `    ${w.path}  ← ${w.pattern}: ${w.reason}`)];
}
