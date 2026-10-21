import type { IssueWaitingKind } from '@forge/contracts/issue-standing';
import type { Said } from '@forge/contracts/said';
import { type WaitingOn, waitingOn } from '@forge/contracts/standing';

/** An issue's wait: whom, for what, by which rule, and the record it names. */
export const wait = (
  kind: IssueWaitingKind,
  who: Said,
  act: Said,
  rule: Said,
  ref: string | null = null,
): WaitingOn<IssueWaitingKind> => waitingOn(kind, { who, act, rule }, { ref });
