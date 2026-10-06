// Which removed entry an added one corrects: the pairing the record gate reads as an edit rather
// than a loss beside an addition. Split out of release-record.mjs; the rule and its measurements are
// in scripts/README.md under `check-release-record.mjs`.

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
 * the pairing takes the MOST pairs it can and their similarity only as the tiebreak.
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

export function matchEdges(edges, removed, added) {
  const matchedFrom = bestMatching(edges, removed.length, added.length);
  const paired = new Map();
  for (const [right, after] of added.entries()) {
    if (matchedFrom[right] !== -1) paired.set(after, removed[matchedFrom[right]]);
  }
  return paired;
}

/** Every removed/added pair the rule above admits, before the matching picks among them. */
export function correctionEdges(removed, added) {
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
