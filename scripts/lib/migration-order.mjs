/**
 * Whether one tree's migrations can be applied alongside every other open branch's: a property of
 * the SET, not of any one journal. Origin and rules: `scripts/README.md`.
 */

const DAY = 86_400_000;

/** @typedef {{ idx: number, when: number, tag: string }} Entry */
/** @typedef {{ branch: string, entries: Entry[] }} Branch */

/** The highest `when` in `entries`, or `-Infinity` where there are none. */
export function floorOf(entries) {
  return entries.reduce((max, e) => (e.when > max ? e.when : max), Number.NEGATIVE_INFINITY);
}

/** The entries of `branch` that `main` does not already carry, in index order. */
export function newEntries(branch, main) {
  const landed = new Set(main.map((e) => e.tag));
  return branch.filter((e) => !landed.has(e.tag)).sort((a, b) => a.idx - b.idx);
}

/** The `when` range a branch occupies, as `[lowest, highest]`. */
function rangeOf(entries) {
  return [Math.min(...entries.map((e) => e.when)), Math.max(...entries.map((e) => e.when))];
}

function name(entry) {
  return `${entry.tag} (idx ${entry.idx}, when ${entry.when})`;
}

/**
 * Refusals against this tree's own entries, never filtered by the floor: a below-floor entry of
 * ours is the damage this check exists to refuse, so dropping it before measuring would be the
 * check deleting its own subject.
 */
function floorRefusals(self, floor, nextWhen) {
  return self.entries
    .filter((e) => e.when <= floor)
    .map((e) => ({
      rule: 'below-floor',
      message:
        `${name(e)} on ${self.branch} does not clear origin/main, whose highest when is ${floor}.\n` +
        '  drizzle reads that number once and applies only entries above it, so this migration\n' +
        `  would be skipped silently and for ever. Take when ${nextWhen}.`,
    }));
}

/** Refusals between two branches' live entries. Used both ways, so nothing here says "yours". */
export function betweenBranches(self, sibling) {
  const refusals = [];
  const shared = [];
  for (const mine of self.entries) {
    for (const theirs of sibling.entries) {
      if (mine.when === theirs.when) {
        shared.push([mine, theirs]);
        refusals.push({
          rule: 'duplicate-when',
          message:
            `${self.branch} and ${sibling.branch} both hold when ${mine.when} — ` +
            `${mine.tag} and ${theirs.tag}.\n` +
            '  Whichever merges second is below the high-water the first one set, and is skipped.',
        });
      }
      if (mine.idx === theirs.idx) {
        refusals.push({
          rule: 'duplicate-idx',
          message:
            `${self.branch} and ${sibling.branch} both hold index ${mine.idx} — ` +
            `${mine.tag} and ${theirs.tag}.`,
        });
      }
      const inverted =
        (mine.idx > theirs.idx && mine.when < theirs.when) ||
        (mine.idx < theirs.idx && mine.when > theirs.when);
      if (inverted) {
        refusals.push({
          rule: 'inverted',
          message:
            `${name(mine)} on ${self.branch} and ${name(theirs)} on ${sibling.branch} disagree:\n` +
            '  one sits above the other by index and below it by when, so the merged journal is\n' +
            '  not monotonic and the lower when is skipped whichever branch lands first.',
        });
      }
    }
  }

  const [mineLow, mineHigh] = rangeOf(self.entries);
  const [theirLow, theirHigh] = rangeOf(sibling.entries);
  const overlaps = mineLow <= theirHigh && theirLow <= mineHigh;
  // `duplicate-when` already named a shared `when`; reporting the straddle too double-charges it.
  const onlyShared = shared.length > 0 && mineLow === mineHigh && theirLow === theirHigh;
  if (overlaps && !onlyShared) {
    refusals.push({
      rule: 'interleaved',
      message:
        `${self.branch} occupies when ${mineLow}..${mineHigh} and ${sibling.branch} occupies ` +
        `${theirLow}..${theirHigh}, which straddle.\n` +
        `    ${self.branch}: ${self.entries.map(name).join(', ')}\n` +
        `    ${sibling.branch}: ${sibling.entries.map(name).join(', ')}\n` +
        '  A branch merges whole, so whichever lands first raises the high-water past the\n' +
        "  other's remainder. No order of these two branches applies both.",
    });
  }
  return refusals;
}

/**
 * Judge one tree's new migrations against the open set. Sibling entries at or below `main`'s floor
 * are STRANDED: reported on their own, counted against nobody.
 * @param {{ main: Entry[], self: Branch, siblings: Branch[] }} set
 */
export function checkSet({ main, self, siblings }) {
  const floor = floorOf(main);
  const stranded = [];
  const live = [];
  for (const sibling of siblings) {
    const below = sibling.entries.filter((e) => e.when <= floor);
    const above = sibling.entries.filter((e) => e.when > floor);
    if (below.length > 0) stranded.push({ branch: sibling.branch, entries: below, floor });
    if (above.length > 0) live.push({ branch: sibling.branch, entries: above });
  }

  const everything = [...main, ...self.entries, ...live.flatMap((b) => b.entries)];
  const next = {
    when: floorOf(everything) + DAY,
    idx: everything.reduce((max, e) => (e.idx > max ? e.idx : max), -1) + 1,
  };

  const refusals = floorRefusals(self, floor, next.when);
  if (self.entries.length > 0) {
    for (const sibling of live) refusals.push(...betweenBranches(self, sibling));
  }

  // What such a pair costs is the claim: a set holding one has no whole merge order, so none is
  // printed.
  const betweenSiblings = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      betweenSiblings.push(...betweenBranches(live[i], live[j]));
    }
  }

  const landing = self.entries.length > 0 ? [self, ...live] : live;
  const ordered = landing
    .map((b) => ({ branch: b.branch, entries: [...b.entries].sort((x, y) => x.when - y.when) }))
    .sort((a, b) => a.entries[0].when - b.entries[0].when);
  const order = betweenSiblings.length > 0 ? [] : ordered;
  const ahead = order.findIndex((b) => b.branch === self.branch);
  const strandedByUs = ahead > 0 ? order.slice(0, ahead) : [];

  return { floor, refusals, betweenSiblings, stranded, order, next, strandedByUs };
}
