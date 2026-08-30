// The verdict half of check-release-record, kept apart from the CLI so it can
// be tested. The CLI reads git and exits; everything a test needs to drive —
// what counts as a release entry, and whether two revisions of the record
// agree — lives here.
//
// What it can see: whether the record still carries the heading its readers
// parse for, and whether an entry that existed at the base revision still
// exists at HEAD. What it CANNOT see: whether an entry is TRUE, or whether the
// change that landed deserved one. Those belong to review and to whoever
// writes the note — a checker ruling on them would be reading prose for
// sincerity.

// cm:edge contract -> packages/web-v2/src/lib/changelog.ts — `RELEASE_HEADING` there is the same shape, and it is what turns this file into the in-app What's New feed; a record with no `## [...]` line parses to an empty array and the feed renders blank for every signed-in user rather than throwing
const RELEASE_HEADING = /^##\s+\[([^\]]+)\]/;

/** The heading every writer of the record appends under, and every cutter promotes. */
export const UNRELEASED = 'Unreleased';

const BULLET = /^[-*+]\s+(.*)$/;
const HEADING = /^#{1,6}\s/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// cm:guard normalise WHITESPACE ONLY. Entries in this file are hard-wrapped, so a reflow moves
// every word to a different line while the entry says exactly what it said — comparing raw lines
// would report a rewrap as 30 deletions, and a gate that fires on formatting is a gate someone
// routes around. Normalising further (case, punctuation) would go the other way and let a real
// rewrite pass as the same entry.
export function normaliseEntry(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Every release entry in the record, as a set of normalised texts.
 *
 * Position-independent on purpose: `forge-cut-release` promotes `## [Unreleased]` to
 * `## [X.Y.Z]` and opens a fresh empty one, which moves every entry under a new heading
 * without losing any. A per-section or positional comparison would turn the next release
 * cut red.
 */
export function parseRecord(text) {
  const sections = [];
  const entries = new Set();
  let inSection = false;
  let fence = null;
  let open = null;

  const flush = () => {
    if (open === null) return;
    const normalised = normaliseEntry(open);
    if (normalised) entries.add(normalised);
    open = null;
  };

  for (const line of String(text ?? '').split('\n')) {
    const f = FENCE.exec(line);
    if (f) {
      flush();
      const [char, len] = [f[1][0], f[1].length];
      if (fence === null) fence = { char, len };
      else if (char === fence.char && len >= fence.len) fence = null;
      continue;
    }
    // cm:why a fenced block is an example of the format, not the record — the old header quoted
    // its own style rules, and counting those as entries would make editing the guide a deletion
    if (fence) continue;

    const heading = RELEASE_HEADING.exec(line);
    if (heading) {
      flush();
      sections.push(heading[1].trim());
      inSection = true;
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      continue;
    }
    if (!inSection) continue;

    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      open = bullet[1];
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (open !== null) open += ` ${line}`;
  }
  flush();

  return { sections, entries };
}

/** Amnesty entries are matched after the same normalisation the record gets, or they never match. */
function forgiven(amnesty) {
  const out = new Map();
  for (const row of amnesty?.removals ?? []) {
    const entry = normaliseEntry(String(row?.entry ?? ''));
    const reason = String(row?.reason ?? '').trim();
    if (entry && reason) out.set(entry, reason);
  }
  return out;
}

/**
 * Judge the record at HEAD against the same record at the base revision.
 *
 * `code`: 0 the record holds · 1 it was broken · 2 the judgement could not be made.
 */
// cm:guard a base revision of `null` is EXIT 2, never 0. Measured on this repo 2026-08-24 one gate
// over: the `conformance` job checked out at depth 1, every ratchet comparison was skipped, and CI
// went green on a check that never ran. A comparative rule with nothing to compare against has not
// been checked, and this repo does not read that as a pass.
export function judge({ head, base, amnesty }) {
  if (typeof head !== 'string') {
    return { code: 2, reason: 'CHANGELOG.md is unreadable at HEAD' };
  }
  if (base !== null && typeof base !== 'string') {
    return { code: 2, reason: 'the base revision of CHANGELOG.md is unreadable' };
  }

  const now = parseRecord(head);
  const violations = [];

  if (!now.sections.includes(UNRELEASED)) {
    violations.push({
      rule: 'structure',
      detail:
        `CHANGELOG.md carries no \`## [${UNRELEASED}]\` heading. Five readers need it: the in-app ` +
        `What's New feed, the release step, the release cutter, the batch release plan, and the ` +
        `release-notes schema. Without it the feed renders blank instead of failing.`,
    });
  }

  if (base === null) {
    return violations.length > 0
      ? { code: 1, violations, entries: now.entries.size, sections: now.sections.length }
      : { code: 2, reason: 'no base revision to compare the record against' };
  }

  const was = parseRecord(base);
  const pardons = forgiven(amnesty);
  const unpardoned = [];
  for (const entry of was.entries) {
    if (now.entries.has(entry) || pardons.has(entry)) continue;
    unpardoned.push(entry);
  }
  if (unpardoned.length > 0) {
    violations.push({
      rule: 'no-silent-loss',
      detail: `${unpardoned.length} release entr${unpardoned.length === 1 ? 'y' : 'ies'} present at the base revision ${
        unpardoned.length === 1 ? 'is' : 'are'
      } gone from CHANGELOG.md`,
      removed: unpardoned,
    });
  }

  return {
    code: violations.length > 0 ? 1 : 0,
    violations,
    entries: now.entries.size,
    sections: now.sections.length,
  };
}
