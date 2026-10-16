/**
 * The two release reasons that hold every issue at the gate, in the number of issues they name:
 * the one issue, all of them counted, or, where none is named, every issue (ISS-1229 r11).
 */

import { ISSUE_STATUS_LABELS } from '../issues/status-sets.js';
import { agree } from './counted.js';

const AT = ISSUE_STATUS_LABELS.awaiting_release;

export function criteriaUnearnedLead(n: number): string {
  if (n === 0) {
    return `Every issue at ${AT} still owes a verdict on an acceptance criterion, so the automatic release cuts nothing until each is recorded`;
  }
  return n === 1
    ? `The one issue at ${AT} still owes a verdict on an acceptance criterion, so the automatic release cuts nothing until each verdict it owes is recorded`
    : `All ${n} issues at ${AT} still owe a verdict on an acceptance criterion, so the automatic release cuts nothing until each verdict they owe is recorded`;
}

export function unroutedRemedy(n: number): string {
  const held =
    n === 0
      ? 'every issue waiting at the gate is held on that one reason'
      : n === 1
        ? 'the one issue waiting at the gate is held on that one reason'
        : `all ${n} issues waiting at the gate are held on that one reason`;
  const again = n === 0 ? 'every waiting issue' : agree(n, 'it', 'them');
  return `This project releases without a person acting, only an issue whose every acceptance criterion is earned at what it is serving, and nothing here can read what it is serving — so no verdict a run records can earn one, and ${held}. Give it a way to be read, and the next sweep weighs ${again} again.`;
}
