// What each kind of stuck-issue notice says of an issue, said once. The bell titles a kind's group
// with it, the project page's headline counts by it and Needs you names a row by it, so the three
// cannot drift into two wordings of one reason (ISS-1229 r14). The kinds are the contracts' stuck
// kinds (`notifications.ts`), restated here because this file is built on its own for core.

export type StuckKind = 'waiting' | 'idle' | 'owed_close' | 'orphan' | 'other';

/** The predicate, for one issue and for several: the sentence each surface builds around it. */
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

/** The headline's counted sentence, as in "2 issues shipped their code and were never closed." */
export function stuckCountSentence(kind: StuckKind, n: number): string {
  return n === 1 ? `1 issue ${SAID[kind].one}.` : `${n} issues ${SAID[kind].many}.`;
}

/** What a row says of its one issue, as in "Shipped its code and was never closed". */
export function stuckRowWords(kind: StuckKind): string {
  const one = SAID[kind].one;
  return `${one.charAt(0).toUpperCase()}${one.slice(1)}`;
}
