import {
  FRAGMENT_DIR,
  fragmentFiles,
  fragmentPath,
  normaliseEntry,
  readFragment,
  SECTIONS,
} from './changelog-fragments.mjs';
import { CORRECTION_SPAN, correctionEdges, matchEdges } from './entry-correction.mjs';
import { withoutComments, withoutFences } from './markdown.mjs';

export { CORRECTION_SPAN };

const RELEASE_HEADING = /^##\s+\[([^\]]+)\]/;

/** The heading CHANGELOG.md no longer carries: unreleased entries are `changelog.d/` fragments. */
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

/**
 * Every release entry in the record, as a set of normalised texts, and — separately — any entry
 * still written under a `## [Unreleased]` heading, with the `###` section it sat in.
 *
 * Position-independent on purpose: a release moves entries from `changelog.d/` fragments into a
 * new version section without losing any, and a correction may touch an entry in any section. A
 * per-section or positional comparison would turn the next release cut red.
 */
export function parseRecord(text) {
  const sections = [];
  const entries = new Set();
  const repeatedSubsections = [];
  const orphans = new Map();
  const unreleased = [];
  const sectionOf = new Map();
  let inSection = false;
  let subsectionTitle = null;
  let open = null;
  let seenSubsections = null;
  let last = null;

  const flush = () => {
    if (open === null) return;
    const normalised = normaliseEntry(open);
    if (normalised) {
      entries.add(normalised);
      last = normalised;
      sectionOf.set(normalised, sections.at(-1));
      if (sections.at(-1) === UNRELEASED)
        unreleased.push({ entry: normalised, section: subsectionTitle });
    }
    open = null;
  };

  for (const line of withoutComments(withoutFences(String(text ?? ''))).split('\n')) {
    const heading = RELEASE_HEADING.exec(line);
    if (heading) {
      flush();
      last = null;
      sections.push(heading[1].trim());
      inSection = true;
      subsectionTitle = null;
      seenSubsections = new Set();
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      last = null;
      const subsection = inSection ? SUBSECTION_HEADING.exec(line) : null;
      if (subsection) {
        const title = subsection[1];
        subsectionTitle = title;
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
    if (open !== null) {
      open += ` ${line}`;
      continue;
    }
    if (last !== null) orphans.set(last, normaliseEntry(`${orphans.get(last) ?? ''} ${line}`));
  }
  flush();

  return { sections, entries, repeatedSubsections, orphans, unreleased, sectionOf };
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
 * prose a blank line cut off from its bullet is NOT part of the entry — `parseRecord`
 * drops it — so an added entry carrying such prose is refused unless the published entry it PAIRS
 * WITH already carried exactly it. Compatibility is an edge the one-to-one matching runs over,
 * never a test on edge existence or on a matching already chosen; scripts/README.md holds the two
 * holes each looser reading opened.
 */
function orphanCompatible(now, was, removed, added) {
  return ({ left, right }) => {
    const prose = now.orphans.get(added[right]);
    return prose === undefined || was.orphans.get(removed[left]) === prose;
  };
}

const opening = (text, words) => {
  const taken = normaliseEntry(text).split(' ').slice(0, words).join(' ');
  return taken === normaliseEntry(text) ? taken : `${taken}…`;
};

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
    const corrects = before === undefined ? 0 : wordCount(before);
    const ceiling = Math.max(ENTRY_WORD_BUDGET, corrects);
    const words = wordCount(entry);
    if (words > ceiling) over.push({ entry, words, ceiling, corrects });
  }
  over.sort((a, b) => b.words - a.words);
  return over;
}

/** Fragments as read: `{ file, text }` each, to `{ path, entry, section, problems }`. */
function readAll(files) {
  return fragmentFiles(files ?? []).map(({ file, text }) => ({
    path: `${FRAGMENT_DIR}/${file}`,
    ...readFragment(file, text),
  }));
}

/**
 * The refusal for a `## [Unreleased]` heading in CHANGELOG.md: a writer following the guidance
 * this replaced. Each entry it holds is named with the fragment path it belongs in, so the fix is a
 * move rather than a search.
 */
function unreleasedViolation(now, fragmentName) {
  if (!now.sections.includes(UNRELEASED)) return null;
  const moves = now.unreleased.map(({ entry, section }, i) => {
    const suffix = now.unreleased.length > 1 ? `-${i + 1}` : '';
    const known = SECTIONS.includes(section) ? section : 'Fixed';
    return `${fragmentPath(`${fragmentName}${suffix}`, known)} ← ${opening(entry, 10)}`;
  });
  return {
    rule: 'unreleased-in-record',
    detail:
      `CHANGELOG.md carries a \`## [${UNRELEASED}]\` heading. It holds released sections only: an ` +
      `unreleased entry is a file of its own, \`${FRAGMENT_DIR}/<name>.<section>.md\`, which no other ` +
      `branch writes, and the release writer folds it into the version section. An entry written ` +
      `under [${UNRELEASED}] is what git's merge moved into an already-released section on every ` +
      `release from dev.56 to dev.62. Delete the heading` +
      (moves.length > 0 ? ' and move each entry under it into the fragment named:' : '.'),
    removed: moves,
  };
}

/** Every way a fragment at HEAD is not one, by path. */
function fragmentViolations(fragments) {
  return fragments
    .filter((f) => f.problems.length > 0)
    .map((f) => ({
      rule: 'fragment-shape',
      detail:
        `\`${f.path}\` ${f.problems.join('; ')}. A fragment is \`${FRAGMENT_DIR}/<name>.<section>.md\` ` +
        `(section one of ${SECTIONS.map((x) => x.toLowerCase()).join(', ')}) holding one entry: a bold ` +
        `lead and at most ${ENTRY_WORD_BUDGET} words, with no bullet marker and no heading.`,
    }));
}

/**
 * Entries this change added into a version section the base already held: not a correction of a
 * published entry, and not under [Unreleased] (refused on its own above). That is the merge that
 * slid a branch's entry under a release cut beside it. A version section new at HEAD is a release
 * — one or several, as a promotion carries — so its entries are not counted here.
 */
function directWrites({ added, edited, now, was, fragmentName }) {
  const released = new Set(was.sections.filter((s) => s !== UNRELEASED));
  const direct = added.filter(
    (entry) => released.has(now.sectionOf.get(entry)) && !edited.has(entry),
  );
  if (direct.length === 0) return null;
  return {
    rule: 'entry-outside-a-fragment',
    detail:
      `${direct.length} new entr${direct.length === 1 ? 'y was' : 'ies were'} written into a version ` +
      `section CHANGELOG.md had already released. Only a release writes there, from fragments; write ` +
      `each as \`${fragmentPath(fragmentName)}\` (or .added / .changed / .removed / .security) and take ` +
      `it out of CHANGELOG.md:`,
    removed: direct.map((entry) => `[${now.sectionOf.get(entry)}] ${entry}`),
  };
}

/**
 * Judge the record at HEAD — CHANGELOG.md and the `changelog.d/` fragments beside it — against the
 * same pair at the base revision. `fragments.head` / `fragments.base` are `{ file, text }` lists;
 * `fragmentName` is what a refusal names as the fragment to write (the branch, normally).
 *
 * `code`: 0 the record holds · 1 it was broken · 2 the judgement could not be made.
 */
export function judge({ head, base, amnesty, fragments = {}, fragmentName = '<your-branch>' }) {
  if (typeof head !== 'string') {
    return { code: 2, reason: 'CHANGELOG.md is unreadable at HEAD' };
  }
  if (base !== null && typeof base !== 'string') {
    return { code: 2, reason: 'the base revision of CHANGELOG.md is unreadable' };
  }

  const now = parseRecord(head);
  const nowFragments = readAll(fragments.head);
  const violations = [unreleasedViolation(now, fragmentName), ...fragmentViolations(nowFragments)];

  for (const { section, title } of now.repeatedSubsections) {
    violations.push({
      rule: 'structure',
      detail:
        `\`## [${section}]\` carries \`### ${title}\` more than once. The What's New feed pushes one ` +
        `rendered section per heading, so a reader sees the same category listed twice for one ` +
        `release; fold the bullets under the first \`### ${title}\` instead of appending a new one.`,
    });
  }

  const nowEntries = new Set([...now.entries, ...nowFragments.map((f) => f.entry).filter(Boolean)]);
  const entryCount = nowEntries.size;
  if (base === null) {
    const found = violations.filter(Boolean);
    return found.length > 0
      ? { code: 1, violations: found, entries: entryCount, sections: now.sections.length }
      : { code: 2, reason: 'no base revision to compare the record against' };
  }

  const was = parseRecord(base);
  const wasFragments = readAll(fragments.base);
  const wasEntries = new Set([...was.entries, ...wasFragments.map((f) => f.entry).filter(Boolean)]);
  const removed = [...wasEntries].filter((entry) => !nowEntries.has(entry));
  const added = [...nowEntries].filter((entry) => !wasEntries.has(entry));

  const edges = correctionEdges(removed, added).filter(orphanCompatible(now, was, removed, added));
  const edited = matchEdges(edges, removed, added);
  const orphaned = added
    .filter((entry) => now.orphans.has(entry) && !edited.has(entry))
    .map((entry) => ({ entry, prose: now.orphans.get(entry) }));
  violations.push(directWrites({ added, edited, now, was, fragmentName }));
  for (const { entry, prose } of orphaned) {
    violations.push({
      rule: 'structure',
      detail:
        `\`${opening(entry, 8)}\` is followed by ${wordCount(prose)} words that reach no entry: ` +
        `\`${opening(prose, 8)}\`. A blank line ends a release entry, so prose after one belongs ` +
        `to no bullet — the What's New feed never renders it and this gate cannot see it, which is ` +
        `why the truncated bullet above would otherwise read as a deliberate trim. Join it to that ` +
        `bullet as an indented continuation with no blank line between, or give it a bullet of its ` +
        `own. Only prose this change added is refused here; what the record already carried stands.`,
    });
  }

  const unpardoned = lostEntries(removed, edited, forgiven(amnesty));
  if (unpardoned.length > 0) {
    violations.push({
      rule: 'no-silent-loss',
      detail: `${unpardoned.length} release entr${unpardoned.length === 1 ? 'y' : 'ies'} present at the base revision ${
        unpardoned.length === 1 ? 'is' : 'are'
      } gone from CHANGELOG.md and ${FRAGMENT_DIR}/`,
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
        `${ENTRY_WORD_BUDGET} words` +
        (overBudget.some((o) => o.corrects > 0)
          ? `; one that pairs with a published entry as a correction of it may spend the larger of ` +
            `the ${ENTRY_WORD_BUDGET} and what that entry held. `
          : `, and none of these pairs with a published entry as a correction of it, so none ` +
            `inherits a wider ceiling: an entry replacing more of a published one than a correction ` +
            `may is a new entry however much of the wording it carries over. `) +
        `An entry ` +
        `says what changed and what it means for the reader; the reasoning belongs in the issue and ` +
        `the commit, which is where a reader who wants it will look. Cut it down rather than ` +
        `splitting one change across several bullets — that moves the words, it does not spend fewer.`,
      removed: overBudget.map((o) =>
        o.corrects > 0
          ? `[${o.words} words, correcting an entry of ${o.corrects}; ceiling ${o.ceiling}] ${o.entry}`
          : `[${o.words} words, new entry; ceiling ${o.ceiling}] ${o.entry}`,
      ),
    });
  }

  const found = violations.filter(Boolean);
  return {
    code: found.length > 0 ? 1 : 0,
    violations: found,
    entries: entryCount,
    sections: now.sections.length,
  };
}
