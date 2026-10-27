// What each kind of stuck-issue notice says of an issue, once, for the bell, the headline and Needs
// you alike (ISS-1229 r14). The kinds restate `notifications.ts`'s: this file is built on its own.

export type StuckKind =
  | 'waiting'
  | 'waiting_on_others'
  | 'idle'
  | 'owed_close'
  | 'orphan'
  | 'other';

const SAID: Readonly<Record<StuckKind, { one: string; many: string }>> = {
  waiting: {
    one: 'has been waiting for you for over six hours',
    many: 'have been waiting for you for over six hours',
  },
  // A park somebody else owes: "you" only where the reader owes it (ISS-1229 r16).
  waiting_on_others: {
    one: 'has been waiting for someone else for over six hours',
    many: 'have been waiting for other people for over six hours',
  },
  idle: {
    one: 'is in a live status with no live work behind it',
    many: 'are in a live status with no live work behind them',
  },
  owed_close: {
    one: 'was marked merged and never closed',
    many: 'were marked merged and never closed',
  },
  orphan: {
    one: 'asserts work in progress with no run behind it',
    many: 'assert work in progress with no run behind them',
  },
  other: { one: 'is reported stuck', many: 'are reported stuck' },
};

/** The bell's group title for a kind, as in "Issues that were marked merged and never closed". A
 *  group of waiting parks holds the reader's and other people's alike, so it names neither. */
export function stuckGroupTitle(kind: StuckKind): string {
  if (kind === 'waiting' || kind === 'waiting_on_others') {
    return 'Issues that have been waiting for a person for over six hours';
  }
  return `Issues that ${SAID[kind].many}`;
}

export function stuckCountSentence(kind: StuckKind, n: number): string {
  return n === 1 ? `1 issue ${SAID[kind].one}.` : `${n} issues ${SAID[kind].many}.`;
}

// A bell row's tag for a kind: a phrase its group's title says, never a word none of them uses.
const TAG: Readonly<Record<StuckKind, string | null>> = {
  waiting: 'WAITING',
  waiting_on_others: 'WAITING',
  idle: 'NO LIVE WORK',
  owed_close: 'NEVER CLOSED',
  orphan: 'NO RUN',
  other: null,
};

/** The bell row's tag for a kind, as in "NEVER CLOSED"; null where the kind has no words of its own. */
export function stuckTag(kind: StuckKind): string | null {
  return TAG[kind];
}

/** What a kind says of one issue; a park somebody else owes names them where the row knows who. */
function saidOfOne(kind: StuckKind, owedBy?: string | null): string {
  return kind === 'waiting_on_others' && owedBy
    ? `has been waiting for ${owedBy} for over six hours`
    : SAID[kind].one;
}

/** What a row says of its one issue, as in "Shipped its code and was never closed". */
export function stuckRowWords(kind: StuckKind, owedBy?: string | null): string {
  const one = saidOfOne(kind, owedBy);
  return `${one.charAt(0).toUpperCase()}${one.slice(1)}`;
}

export function stuckClause(kind: StuckKind, owedBy?: string | null): string {
  return `It ${saidOfOne(kind, owedBy)}.`;
}
