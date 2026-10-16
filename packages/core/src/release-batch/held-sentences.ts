/**
 * The two release reasons that hold every issue at the gate, in the number of issues they name:
 * the one issue, both, all of them counted from three, or every issue where none is named (ISS-1229 r11).
 */

import { ISSUE_STATUS_LABELS } from '../issues/status-sets.js';
import { agree, everyOne } from './counted.js';

const AT = ISSUE_STATUS_LABELS.awaiting_release;

export function criteriaUnearnedLead(n: number): string {
  const issues = n === 0 ? 'every issue' : everyOne(n, 'issue');
  const owe = agree(n === 0 ? 1 : n, 'owes', 'owe');
  const theirs = n === 0 ? 'each is' : `each verdict ${agree(n, 'it owes', 'they owe')} is`;
  const lead = `${issues.charAt(0).toUpperCase()}${issues.slice(1)}`;
  return `${lead} at ${AT} still ${owe} a verdict on an acceptance criterion, so the automatic release cuts nothing until ${theirs} recorded`;
}

export function unroutedRemedy(n: number): string {
  const issues = n === 0 ? 'every issue' : everyOne(n, 'issue');
  const held = `${issues} waiting at the gate ${agree(n === 0 ? 1 : n, 'is', 'are')} held on that one reason`;
  const again = n === 0 ? 'every waiting issue' : agree(n, 'it', 'them');
  return `This project releases without a person acting, only an issue whose every acceptance criterion is earned at what it is serving, and nothing here can read what it is serving — so no verdict a run records can earn one, and ${held}. Give it a way to be read, and the next sweep weighs ${again} again.`;
}
