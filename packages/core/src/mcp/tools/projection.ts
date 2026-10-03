import { ANSWER_VIEWS, type AnswerView, type SummaryNotice } from '@forge/contracts/projection';
import { z } from 'zod';

// cm:why one place decides what a tool answers by default, so no tool grows its own idea of
// "summary": a list or a write answers the projection, and view 'full' is the one way to the body (ISS-87)
export const viewInput = z.enum(ANSWER_VIEWS).optional();

export const VIEW_RULE =
  "view: 'summary' (the default) answers a list as summaries and a write as what it changed; " +
  "view: 'full' answers the whole document, which get answers by default (get with view: 'summary' answers the summary).";

export function projectOne<T, S>(
  view: AnswerView | undefined,
  full: T,
  summarize: (full: T) => S,
): T | S {
  return view === 'full' ? full : summarize(full);
}

export function projectMany<T, S>(
  view: AnswerView | undefined,
  rows: readonly T[],
  summarize: (row: T) => S,
): readonly (T | S)[] {
  return view === 'full' ? rows : rows.map(summarize);
}

export function summaryNotice(
  view: AnswerView | undefined,
  full: string,
): SummaryNotice | Record<string, never> {
  return view === 'full' ? {} : { view: 'summary', full };
}
