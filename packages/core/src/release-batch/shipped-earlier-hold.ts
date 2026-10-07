/**
 * What `closeShippedEarlier` could not settle about a waiting row, said on that row's hold.
 *
 * A row keeps one standing hold (`release_holds_standing_uq`), and the hold that decides the row —
 * an aborted release's `RELEASE_ABORT_BLOCKED`, or whatever the sweep weighed it to — stays the
 * hold's code: the abort's lock (`hold.ts` `abortBlockedIssues`) reads that code. What could not be
 * settled is a clause added to that hold's reason and to what it waits for, so the reader sees both
 * the act owed and that Forge could not check the issue had already shipped, and why. The clause is
 * worked out from scratch each sweep: the same answer writes the same words, and none drops it.
 */

import type { ReleaseHold } from './hold.js';

/** One refusal `closeShippedEarlier` named for a row (`shipped-earlier.ts` `Unresolved`). */
export interface ShippedEarlierUnsettled {
  readonly code:
    | 'SHIPPED_EARLIER_HOST_UNAVAILABLE'
    | 'SHIPPED_EARLIER_UNREAD'
    | 'SHIPPED_EARLIER_NOT_CLOSED';
  readonly detail: string;
}

const REASON_MARK = ' Forge could not settle whether an earlier release already shipped this issue';
const WAITING_MARK = '; or, for Forge to settle whether an earlier release shipped it, ';

/** What settles each refusal: the sentence the reason ends on, and the words `waitingFor` adds. */
const SETTLES: Readonly<
  Record<ShippedEarlierUnsettled['code'], { reason: string; waitingFor: string }>
> = {
  SHIPPED_EARLIER_HOST_UNAVAILABLE: {
    reason:
      "Once this project's repository can be read through a source host binding (or, where it has " +
      'none at all, a connected box holding a checkout of it bound to this project answers), the ' +
      'next sweep asks which release holds its commit and, where one does, closes it against that ' +
      'release with nobody acting.',
    waitingFor:
      "a source host binding this project's repository can be read through, or (with none bound) a connected box holding a bound checkout of it",
  },
  SHIPPED_EARLIER_UNREAD: {
    reason:
      'The next sweep asks the repository again; nothing was closed and no release was inferred.',
    waitingFor: 'the repository to answer the comparison on a later sweep',
  },
  SHIPPED_EARLIER_NOT_CLOSED: {
    reason: 'The next sweep tries the close again once the refusal named is cleared.',
    waitingFor: 'the refusal that stopped the close to be cleared',
  },
};

function before(text: string, mark: string): string {
  const at = text.indexOf(mark);
  return at === -1 ? text : text.slice(0, at);
}

/** `hold` as it reads with no shipped-earlier clause: the words its own writer gave it. */
export function withoutShippedEarlier(hold: ReleaseHold): ReleaseHold {
  return {
    ...hold,
    reason: before(hold.reason, REASON_MARK),
    waitingFor: before(hold.waitingFor, WAITING_MARK),
  };
}

/**
 * `hold` with the clause naming what was not settled, or with none where everything was. A clause
 * already on `hold` is replaced, never stacked, so the same answer reads the same every sweep.
 */
export function withShippedEarlier(
  hold: ReleaseHold,
  unsettled: ShippedEarlierUnsettled | undefined,
): ReleaseHold {
  const base = withoutShippedEarlier(hold);
  if (!unsettled) return base;
  const settles = SETTLES[unsettled.code];
  return {
    ...base,
    reason: `${base.reason}${REASON_MARK} (${unsettled.code}): ${unsettled.detail.replace(/[.\s]+$/, '')}. ${settles.reason}`,
    waitingFor: `${base.waitingFor}${WAITING_MARK}${settles.waitingFor}`,
  };
}
