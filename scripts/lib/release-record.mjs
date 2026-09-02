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

import { withoutComments, withoutFences } from './markdown.mjs';

// cm:edge contract -> packages/web-v2/src/lib/changelog.ts — `RELEASE_HEADING` there is the same shape, and it is what turns this file into the in-app What's New feed; a record with no `## [...]` line parses to an empty array and the feed renders blank for every signed-in user rather than throwing
const RELEASE_HEADING = /^##\s+\[([^\]]+)\]/;

/** The heading every writer of the record appends under, and every cutter promotes. */
export const UNRELEASED = 'Unreleased';

const BULLET = /^[-*+]\s+(.*)$/;
const HEADING = /^#{1,6}\s/;
// cm:edge contract -> packages/web-v2/src/lib/changelog.ts — `parseChangelog` pushes ONE rendered section per `###` heading, so a heading repeated inside one release is not cosmetic there: the feed lists the same category twice for one release. Nothing types that agreement, and this rule is the only thing holding it
const SUBSECTION_HEADING = /^###\s+(.+?)\s*$/;

// cm:guard normalise WHITESPACE ONLY. Entries in this file are hard-wrapped, so a reflow moves every word to a different line while the entry says exactly what it said — comparing raw lines would report a rewrap as 30 deletions, and a gate that fires on formatting is a gate someone routes around. Normalising further (case, punctuation) would go the other way and let a real rewrite pass as the same entry.
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
  const repeatedSubsections = [];
  let inSection = false;
  let open = null;
  let seenSubsections = null;

  const flush = () => {
    if (open === null) return;
    const normalised = normaliseEntry(open);
    if (normalised) entries.add(normalised);
    open = null;
  };

  // cm:why a fenced block is an example of the format, not the record — the old header quoted its own style rules, and counting those as entries would make editing the guide a deletion. A commented-out entry is not on the page either, and without `withoutComments` a `<!-- - ISS-000 … -->` line still matched BULLET, so a published entry could be hidden and `no-silent-loss` still pass.
  // cm:edge contract -> scripts/lib/markdown.mjs — `withoutFences` BLANKS fenced lines rather than deleting them; parseRecord's blank-line branch then flushes, which is what the inline fence tracker used to do
  for (const line of withoutComments(withoutFences(String(text ?? ''))).split('\n')) {
    const heading = RELEASE_HEADING.exec(line);
    if (heading) {
      flush();
      sections.push(heading[1].trim());
      inSection = true;
      seenSubsections = new Set();
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      const subsection = inSection ? SUBSECTION_HEADING.exec(line) : null;
      if (subsection) {
        const title = subsection[1];
        if (seenSubsections.has(title)) {
          repeatedSubsections.push({ section: sections.at(-1), title });
        } else seenSubsections.add(title);
      }
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

  return { sections, entries, repeatedSubsections };
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
// cm:guard a base revision of `null` is EXIT 2, never 0. Measured on this repo 2026-08-24 one gate over: the `conformance` job checked out at depth 1, every ratchet comparison was skipped, and CI went green on a check that never ran. A comparative rule with nothing to compare against has not been checked, and this repo does not read that as a pass.
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

  for (const { section, title } of now.repeatedSubsections) {
    violations.push({
      rule: 'structure',
      detail:
        `\`## [${section}]\` carries \`### ${title}\` more than once. The What's New feed pushes one ` +
        `rendered section per heading, so a reader sees the same category listed twice for one ` +
        `release; fold the bullets under the first \`### ${title}\` instead of appending a new one.`,
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
