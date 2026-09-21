import { withoutComments, withoutFences } from './markdown.mjs';

const RELEASE_HEADING = /^##\s+\[([^\]]+)\]/;

/** The heading every writer of the record appends under, and every cutter promotes. */
export const UNRELEASED = 'Unreleased';

/**
 * Words an entry may spend. A release entry is read in a feed, beside others, by someone
 * deciding whether this release touches them — so it says what changed and what it means
 * for the reader, and the reasoning that produced it lives in the issue and the commit.
 *
 * Measured 2026-09-16, when nothing bounded it: 443 entries, 86,206 words, median 173 and
 * one at 1,027. Three quarters were over 100. That is the failure mode the community names
 * beside the raw-commit dump — prose long enough that the detail a reader came for is in it
 * somewhere, which is not the same as being findable.
 */
export const ENTRY_WORD_BUDGET = 40;

/** Words in a normalised entry. */
export function wordCount(entry) {
  const trimmed = normaliseEntry(entry);
  return trimmed === '' ? 0 : trimmed.split(' ').length;
}

const BULLET = /^[-*+]\s+(.*)$/;
const HEADING = /^#{1,6}\s/;
const SUBSECTION_HEADING = /^###\s+(.+?)\s*$/;

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

  // Only entries this change ADDS are measured. The record is edited one line at a time or
  // not at all (the `record` axis carries no baseline for the same reason), so the entries
  // already published are rewritten deliberately rather than frozen in bulk here — a
  // baseline would make 333 of them permanent by declaring them once.
  const overBudget = [];
  for (const entry of now.entries) {
    if (was.entries.has(entry)) continue;
    const words = wordCount(entry);
    if (words > ENTRY_WORD_BUDGET) overBudget.push({ entry, words });
  }
  if (overBudget.length > 0) {
    overBudget.sort((a, b) => b.words - a.words);
    violations.push({
      rule: 'entry-budget',
      detail:
        `${overBudget.length} new release entr${overBudget.length === 1 ? 'y' : 'ies'} over ` +
        `${ENTRY_WORD_BUDGET} words (longest ${overBudget[0].words}). An entry says what changed and ` +
        `what it means for the reader; the reasoning belongs in the issue and the commit, which is ` +
        `where a reader who wants it will look. Cut it down rather than splitting one change across ` +
        `several bullets — that moves the words, it does not spend fewer.`,
      removed: overBudget.map((o) => `[${o.words} words] ${o.entry}`),
    });
  }

  return {
    code: violations.length > 0 ? 1 : 0,
    violations,
    entries: now.entries.size,
    sections: now.sections.length,
  };
}
