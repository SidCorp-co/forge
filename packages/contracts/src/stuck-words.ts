// What each kind of stuck-issue notice says of an issue, once, for the bell, the headline and Needs
// you alike (ISS-1229 r14). The kinds restate `notifications.ts`'s: this file is built on its own.

export type StuckKind = 'waiting' | 'idle' | 'owed_close' | 'orphan' | 'other';

const SAID: Readonly<Record<StuckKind, { one: string; many: string }>> = {
  waiting: {
    one: 'has been waiting for you for over six hours',
    many: 'have been waiting for you for over six hours',
  },
  idle: {
    one: 'is in a live status with no live work behind it',
    many: 'are in a live status with no live work behind them',
  },
  owed_close: {
    one: 'shipped its code and was never closed',
    many: 'shipped their code and were never closed',
  },
  orphan: {
    one: 'asserts work in progress with no run behind it',
    many: 'assert work in progress with no run behind them',
  },
  other: { one: 'is reported stuck', many: 'are reported stuck' },
};

/** The bell's group title for a kind, as in "Issues that shipped their code and were never closed". */
export function stuckGroupTitle(kind: StuckKind): string {
  return `Issues that ${SAID[kind].many}`;
}

export function stuckCountSentence(kind: StuckKind, n: number): string {
  return n === 1 ? `1 issue ${SAID[kind].one}.` : `${n} issues ${SAID[kind].many}.`;
}

// A bell row's tag for a kind: a phrase its group's title says, never a word none of them uses.
const TAG: Readonly<Record<StuckKind, string | null>> = {
  waiting: 'WAITING',
  idle: 'NO LIVE WORK',
  owed_close: 'NEVER CLOSED',
  orphan: 'NO RUN',
  other: null,
};

/** The bell row's tag for a kind, as in "NEVER CLOSED"; null where the kind has no words of its own. */
export function stuckTag(kind: StuckKind): string | null {
  return TAG[kind];
}

/** What a row says of its one issue, as in "Shipped its code and was never closed". */
export function stuckRowWords(kind: StuckKind): string {
  const one = SAID[kind].one;
  return `${one.charAt(0).toUpperCase()}${one.slice(1)}`;
}
