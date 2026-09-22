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
  const orphans = new Map();
  let inSection = false;
  let open = null;
  let seenSubsections = null;
  let last = null;

  const flush = () => {
    if (open === null) return;
    const normalised = normaliseEntry(open);
    if (normalised) {
      entries.add(normalised);
      last = normalised;
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
      seenSubsections = new Set();
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      last = null;
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
    if (open !== null) {
      open += ` ${line}`;
      continue;
    }
    if (last !== null) orphans.set(last, normaliseEntry(`${orphans.get(last) ?? ''} ${line}`));
  }
  flush();

  return { sections, entries, repeatedSubsections, orphans };
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
 * record's own 572 entries; the figures are in scripts/README.md beside the span's.
 */
const SAME_ENTRY_SURVIVAL = 0.5;

/**
 * Words one correction may move in each direction: at most this many of the published entry's words
 * gone, at most this many new ones standing where they were. Absolute rather than a share, because
 * a share of a long entry is buyable with background prose at any threshold. Measured, and why no
 * share stands in for it: scripts/README.md under `check-release-record.mjs`.
 */
export const CORRECTION_SPAN = 16;

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
 * cm:guard the pairing takes the MOST pairs it can and their similarity only as the tiebreak.
 * Taking the likeliest candidate irrevocably is a different answer: two genuine corrections in one
 * change can refuse each other — one reported lost and the other over budget — while a pairing that
 * satisfies both exists. Augmenting paths, so a pair already held can be given up to buy two.
 */
function bestMatching(edges, leftCount, rightCount) {
  const matchedFrom = new Int32Array(rightCount).fill(-1);
  if (edges.length === 0) return matchedFrom;

  const adjacency = Array.from({ length: leftCount }, () => []);
  const weights = new Map();
  // A pair is worth 1 and its similarity a fraction of one no number of pairs can add up to.
  const tiebreak = 1 / (leftCount + rightCount + 1);
  for (const { left, right, share } of edges) {
    adjacency[left].push(right);
    weights.set(left * rightCount + right, 1 + share * tiebreak);
  }
  const weightOf = (left, right) => weights.get(left * rightCount + right);

  const matchedTo = new Int32Array(leftCount).fill(-1);
  for (;;) {
    const end = augmentOnce({ adjacency, weightOf, matchedTo, matchedFrom, leftCount, rightCount });
    if (end === null) return matchedFrom;
    for (let right = end.right; right !== -1; ) {
      const left = end.cameFromLeft[right];
      const previous = end.cameFromRight[left];
      matchedTo[left] = right;
      matchedFrom[right] = left;
      right = previous;
    }
  }
}

/**
 * One augmenting step of the above: the highest-gain alternating path from a free removed entry to
 * a free added one, relaxed until nothing moves because it may run back through pairs already
 * taken. Null when the matching cannot grow, which is its maximum.
 */
function augmentOnce({ adjacency, weightOf, matchedTo, matchedFrom, leftCount, rightCount }) {
  const costLeft = new Float64Array(leftCount).fill(Number.POSITIVE_INFINITY);
  const costRight = new Float64Array(rightCount).fill(Number.POSITIVE_INFINITY);
  const cameFromLeft = new Int32Array(rightCount).fill(-1);
  const cameFromRight = new Int32Array(leftCount).fill(-1);
  for (let left = 0; left < leftCount; left += 1) if (matchedTo[left] === -1) costLeft[left] = 0;

  for (let pass = 0; pass <= leftCount + rightCount; pass += 1) {
    let moved = false;
    for (let left = 0; left < leftCount; left += 1) {
      if (costLeft[left] === Number.POSITIVE_INFINITY) continue;
      for (const right of adjacency[left]) {
        if (matchedTo[left] === right) continue;
        const cost = costLeft[left] - weightOf(left, right);
        if (cost < costRight[right] - 1e-9) {
          costRight[right] = cost;
          cameFromLeft[right] = left;
          moved = true;
        }
      }
    }
    for (let right = 0; right < rightCount; right += 1) {
      const left = matchedFrom[right];
      if (left === -1 || costRight[right] === Number.POSITIVE_INFINITY) continue;
      const cost = costRight[right] + weightOf(left, right);
      if (cost < costLeft[left] - 1e-9) {
        costLeft[left] = cost;
        cameFromRight[left] = right;
        moved = true;
      }
    }
    if (!moved) break;
  }

  let best = -1;
  for (let right = 0; right < rightCount; right += 1) {
    if (matchedFrom[right] !== -1 || costRight[right] === Number.POSITIVE_INFINITY) continue;
    if (best === -1 || costRight[right] < costRight[best]) best = right;
  }
  return best === -1 ? null : { right: best, cameFromLeft, cameFromRight };
}

/**
 * cm:guard two entries are THE SAME ENTRY when more than half the words of the longer one survive
 * into the other in order AND the change moved at most CORRECTION_SPAN words each way; each removed
 * entry pairs with at most one added entry. Nothing type-checks that, and it is the whole hole this
 * pairing could become, so it is bounded three times — the share, the span, and the ceiling a
 * paired entry answers to, which is the larger of the budget and what it replaced.
 */
export function pairEdits(removed, added) {
  return matchEdges(correctionEdges(removed, added), removed, added);
}

function matchEdges(edges, removed, added) {
  const matchedFrom = bestMatching(edges, removed.length, added.length);
  const paired = new Map();
  for (const [right, after] of added.entries()) {
    if (matchedFrom[right] !== -1) paired.set(after, removed[matchedFrom[right]]);
  }
  return paired;
}

/** Every removed/added pair the rule above admits, before the matching picks among them. */
function correctionEdges(removed, added) {
  const edges = [];
  for (const [left, before] of removed.entries()) {
    const was = before.split(' ');
    for (const [right, after] of added.entries()) {
      const now = after.split(' ');
      const longest = Math.max(was.length, now.length);
      const floor = longest * SAME_ENTRY_SURVIVAL;
      if (Math.min(was.length, now.length) <= floor) continue;
      if (Math.abs(was.length - now.length) > CORRECTION_SPAN) continue;
      const shared = sharedWords(was, now);
      if (shared <= floor || Math.max(was.length, now.length) - shared > CORRECTION_SPAN) continue;
      const survived = survivingRun(was, now);
      if (survived <= floor) continue;
      if (was.length - survived > CORRECTION_SPAN || now.length - survived > CORRECTION_SPAN) {
        continue;
      }
      edges.push({ left, right, share: survived / longest });
    }
  }
  return edges;
}

/**
 * cm:guard prose a blank line cut off from its bullet is NOT part of the entry — `parseRecord`
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

  const edges = correctionEdges(removed, added).filter(orphanCompatible(now, was, removed, added));
  const edited = matchEdges(edges, removed, added);
  const orphaned = added
    .filter((entry) => now.orphans.has(entry) && !edited.has(entry))
    .map((entry) => ({ entry, prose: now.orphans.get(entry) }));
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

  return {
    code: violations.length > 0 ? 1 : 0,
    violations,
    entries: now.entries.size,
    sections: now.sections.length,
  };
}
