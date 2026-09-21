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
 * The share of the longer entry's words that must survive, in order, for one entry to read as an
 * edit of another rather than as an unrelated addition beside a deletion. Measured over this
 * record's own 572 entries: 14,270 sampled pairs of DIFFERENT entries peaked at 0.250, while the
 * corrections the amnesty file declares ran 0.469 to 0.996 and every deletion there 0.283 or less.
 */
const SAME_ENTRY_SURVIVAL = 0.5;

/** Words of `a` that `b` also holds, ignoring order — an exact ceiling on the ordered run below. */
function sharedWords(a, b) {
  const spare = new Map();
  for (const word of a) spare.set(word, (spare.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of b) {
    const left = spare.get(word) ?? 0;
    if (left > 0) {
      spare.set(word, left - 1);
      shared += 1;
    }
  }
  return shared;
}

/** Longest run of words appearing in both, in order, not necessarily adjacent. */
function survivingRun(a, b) {
  let prev = new Uint32Array(b.length + 1);
  let row = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    [prev, row] = [row, prev];
    row.fill(0);
  }
  return prev[b.length];
}

/**
 * cm:guard two entries are THE SAME ENTRY when more than half the words of the longer one survive
 * into the other in order; each removed entry pairs with at most one added entry, best match first.
 * Nothing type-checks that, and it is the whole hole this pairing could become, so it is bounded
 * twice: the threshold sits above the 0.250 scored by the most alike pair of genuinely different
 * entries this record holds, and a paired entry answers to the larger of the budget and what it
 * replaced, so a deletion dressed as an edit buys no words.
 */
export function pairEdits(removed, added) {
  const candidates = [];
  for (const before of removed) {
    const was = before.split(' ');
    for (const after of added) {
      const now = after.split(' ');
      const longest = Math.max(was.length, now.length);
      const floor = longest * SAME_ENTRY_SURVIVAL;
      if (Math.min(was.length, now.length) <= floor) continue;
      if (sharedWords(was, now) <= floor) continue;
      const survived = survivingRun(was, now);
      if (survived > floor) candidates.push({ before, after, share: survived / longest });
    }
  }
  candidates.sort((x, y) => y.share - x.share);

  const paired = new Map();
  const spent = new Set();
  for (const { before, after } of candidates) {
    if (spent.has(before) || paired.has(after)) continue;
    spent.add(before);
    paired.set(after, before);
  }
  return paired;
}

function lostEntries(removed, edited, pardons) {
  const kept = new Set(edited.values());
  return removed.filter((entry) => !kept.has(entry) && !pardons.has(entry));
}

/**
 * Words an added entry may spend: the budget, or — where this change EDITS a published entry — the
 * larger of the budget and what that entry already held, so a correction is never the cheaper way.
 */
function overBudgetEntries(added, edited) {
  const over = [];
  for (const entry of added) {
    const before = edited.get(entry);
    const ceiling =
      before === undefined ? ENTRY_WORD_BUDGET : Math.max(ENTRY_WORD_BUDGET, wordCount(before));
    const words = wordCount(entry);
    if (words > ceiling) over.push({ entry, words, ceiling });
  }
  over.sort((a, b) => b.words - a.words);
  return over;
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
  const removed = [...was.entries].filter((entry) => !now.entries.has(entry));
  const added = [...now.entries].filter((entry) => !was.entries.has(entry));
  const edited = pairEdits(removed, added);

  const unpardoned = lostEntries(removed, edited, forgiven(amnesty));
  if (unpardoned.length > 0) {
    violations.push({
      rule: 'no-silent-loss',
      detail: `${unpardoned.length} release entr${unpardoned.length === 1 ? 'y' : 'ies'} present at the base revision ${
        unpardoned.length === 1 ? 'is' : 'are'
      } gone from CHANGELOG.md`,
      removed: unpardoned,
    });
  }

  const overBudget = overBudgetEntries(added, edited);
  if (overBudget.length > 0) {
    violations.push({
      rule: 'entry-budget',
      detail:
        `${overBudget.length} release entr${overBudget.length === 1 ? 'y' : 'ies'} over budget ` +
        `(longest ${overBudget[0].words} words). An entry this change adds may spend ` +
        `${ENTRY_WORD_BUDGET} words; one it edits may spend what that entry already held. An entry ` +
        `says what changed and what it means for the reader; the reasoning belongs in the issue and ` +
        `the commit, which is where a reader who wants it will look. Cut it down rather than ` +
        `splitting one change across several bullets — that moves the words, it does not spend fewer.`,
      removed: overBudget.map((o) =>
        o.ceiling > ENTRY_WORD_BUDGET
          ? `[${o.words} words, was ${o.ceiling}] ${o.entry}`
          : `[${o.words} words] ${o.entry}`,
      ),
    });
  }

  return {
    code: violations.length > 0 ? 1 : 0,
    violations,
    entries: now.entries.size,
    sections: now.sections.length,
  };
}
