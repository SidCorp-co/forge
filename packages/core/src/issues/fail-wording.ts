// How a failing verdict is said on the issue it reaches (`fail-reopen.ts`), and how the way back from
// a requirement-level fail's reopen reads it again (`fail-return.ts`, ISS-760): one wording, so the
// writer and the reader cannot drift. A reopen a requirement-level fail made before ISS-756 said the
// issue `delivered` the BC; since then it `traces` it. Both are read.

/** What failed, by which verdict and why: the lead of a fail's reopen reason and of its stays note. */
export function failedWhat(p: {
  requirement: string | null;
  criterion: number | null;
  verdictId: string;
  reason: string | null;
}): string {
  const what = p.requirement
    ? `${p.requirement}, which this issue traces, was judged fail at its requirement`
    : `criterion ${p.criterion} was judged fail`;
  return `${what} (verdict ${p.verdictId})${p.reason ? `: ${p.reason}` : ''}`;
}

/** The note on an issue a requirement-level fail leaves where it is (ISS-756), or sends back to (ISS-760). */
export function staysNote(what: string, status: string, why: string): string {
  return `${what}. It stays at \`${status}\`: ${why}.`;
}

const REQUIREMENT_FAIL_CITED =
  /\bwhich this issue (?:traces|delivered), was judged fail at its requirement \(verdict ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/u;

/**
 * The requirement verdict a reopen reason cites, where the reason is a requirement-level fail's as
 * `failedWhat` writes it; null for any other reason. The id is a claim the caller checks against the
 * verdict it names, never trusted for the words around it.
 */
export function requirementFailCited(reason: string | null): string | null {
  return reason?.match(REQUIREMENT_FAIL_CITED)?.[1] ?? null;
}
