// The wording of a business criterion a trace ties to: the one live at the revision the issue was
// planned against (`store.ts:tracedInputs`, `tie.ts:appendTracedCriteria`).

import type { traceWordingsOf } from '../ports.js';

export type Wording = TraceWordings['wordings'][number];
type TraceWordings = Awaited<ReturnType<typeof traceWordingsOf>>;

/** The one wording of `code` live at `revision`, or null where there is none or more than one. */
export function liveWordingAt(
  wordings: readonly Wording[],
  code: string,
  revision: number | null,
): Wording | null {
  const live = wordings.filter(
    (w) =>
      w.code === code &&
      revision !== null &&
      w.sinceRevision <= revision &&
      (w.retiredRevision === null || w.retiredRevision > revision),
  );
  return live.length === 1 ? (live[0] ?? null) : null;
}
