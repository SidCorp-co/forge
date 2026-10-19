export interface ScoredHit {
  sourceRef: string;
  score: number;
}

const SCORE_DIGITS = 6;
const SCORE_EPSILON = 10 ** -SCORE_DIGITS;

const ladder = (hits: readonly ScoredHit[]) => hits.map((h) => h.score.toFixed(SCORE_DIGITS));

/**
 * Search lists a tie by memory id, but which tied rows a cut keeps is the vector index's choice on
 * the flat read, so a cut inside a tie has no member: two lists agree when they climb one score
 * ladder and hold the same hits above the lowest score kept. `null` is agreement, anything else
 * names the first difference.
 */
export function neighbourFault(
  stored: readonly ScoredHit[],
  fresh: readonly ScoredHit[],
): string | null {
  const storedLadder = ladder(stored);
  const freshLadder = ladder(fresh);
  if (storedLadder.join() !== freshLadder.join()) {
    return `score ladders differ: stored [${storedLadder.join(', ')}], fresh [${freshLadder.join(', ')}]`;
  }
  const floor = Math.min(...fresh.map((h) => h.score));
  const above = (hits: readonly ScoredHit[]) =>
    hits
      .filter((h) => h.score > floor + SCORE_EPSILON)
      .map((h) => h.sourceRef)
      .sort();
  const storedAbove = above(stored);
  const freshAbove = above(fresh);
  if (storedAbove.join() !== freshAbove.join()) {
    return `hits above the lowest kept score differ: stored [${storedAbove.join(', ')}], fresh [${freshAbove.join(', ')}]`;
  }
  return null;
}
