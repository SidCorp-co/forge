/**
 * ISS-1051/ISS-1061/ISS-1066 — the ordered checks, split out of `grade.test.ts` when that file
 * crossed the 500-line budget. `inOrder`, `listInOrder`, `labeled` and `linkTo` all read a value
 * the deployment supplied, which is what makes their matching rules load-bearing.
 */

import { describe, expect, it } from 'vitest';
import { gradeTurn, type TurnFacts } from './grade.js';
import type { Check } from './task.js';
import type { Attempt } from './trail.js';

const UUID = '22222222-2222-4222-8222-222222222222';
const DEAD = '33333333-3333-4333-8333-333333333333';

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  chatLogId: 'log',
  calls: [],
  iterations: 1,
  ms: 100,
  reply: 'ok',
  error: null,
  ...over,
});

const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({
  delivered: 'A plain answer.',
  attempts: [attempt()],
  seconds: 1,
  budgetSeconds: 60,
  values: {},
  lookups: {},
  preferenceRows: [],
  notesKept: null,
  ...over,
});

describe('inOrder', () => {
  const inOrder = (delivered: string | null) =>
    gradeTurn(
      { message: 'm', checks: [{ kind: 'inOrder', patterns: ['{first}', /wednesday/i, 'last'] }] },
      facts({ delivered, values: { first: 'Priya' } }),
    ).evidence;

  it('passes when every pattern matches and each first match comes after the one before', () => {
    expect(inOrder('Priya reviews; we deploy on Wednesday; last of all, the smoke test.')).toEqual(
      [],
    );
  });

  it('names a pattern that never matched, and one that came before its predecessor', () => {
    expect(inOrder('On Wednesday Priya reviews; last.').map((e) => e.fact)).toEqual([
      'reply names /wednesday/i before Priya',
    ]);
    expect(inOrder('Priya, then last.').map((e) => [e.mode, e.fact])).toEqual([
      ['unanswered', 'reply does not match /wednesday/i'],
    ]);
    expect(inOrder(null)).toEqual([{ mode: 'unanswered', fact: 'no assistant message delivered' }]);
  });
});

describe('listInOrder, labeled and linkTo (codex F1–F3 on ISS-1061)', () => {
  const grade = (check: Check, delivered: string | null) =>
    gradeTurn(
      { message: 'm', checks: [check] },
      facts({
        delivered,
        values: { stateList: 'open, in_progress, awaiting_release', n: '3', id: UUID },
      }),
    ).evidence;

  it('listInOrder splits the filled list and holds every member to its place', () => {
    const check: Check = { kind: 'listInOrder', list: '{stateList}' };
    expect(grade(check, 'open → in_progress → awaiting_release')).toEqual([]);
    expect(grade(check, 'open → awaiting_release').map((e) => e.fact)).toEqual([
      'reply does not match in_progress',
    ]);
    expect(grade(check, 'in_progress, open, awaiting_release').map((e) => e.fact)).toEqual([
      'reply names in_progress before open',
    ]);
    expect(grade(check, null)).toEqual([
      { mode: 'unanswered', fact: 'no assistant message delivered' },
    ]);
  });

  // cm:why measured, not imagined: on the QA project `open-issues-linked` scored 0/3 against beta on
  // 2026-09-16 with a reply that had listed all five in the deployment's own order — `ISS-2` matched
  // inside `ISS-25`, and `ISS-10` inside an `ISS-1056` that the newest issue's title carried
  // (ISS-1066)
  it('holds an issue key to its whole self, so a key that prefixes another is not found inside it', () => {
    const keys = 'ISS-25, ISS-11, ISS-10, ISS-9, ISS-2';
    const check: Check = { kind: 'listInOrder', list: '{openIssueKeys}' };
    const reply = [
      '- [ISS-25 — Assistant weekly reading (pinned issue, ISS-1056)](/x/1)',
      '- [ISS-11 — one](/x/2)',
      '- [ISS-10 — two](/x/3)',
      '- [ISS-9 — three](/x/4)',
      '- [ISS-2 — four](/x/5)',
    ].join('\n');
    const evidence = gradeTurn(
      { message: 'm', checks: [check] },
      facts({ delivered: reply, values: { openIssueKeys: keys } }),
    ).evidence;
    expect(evidence).toEqual([]);
    // and a reply that really is out of order still fails: the two middle lines swapped
    const swapped = [
      '- [ISS-25 — Assistant weekly reading (pinned issue, ISS-1056)](/x/1)',
      '- [ISS-10 — two](/x/3)',
      '- [ISS-11 — one](/x/2)',
      '- [ISS-9 — three](/x/4)',
      '- [ISS-2 — four](/x/5)',
    ].join('\n');
    expect(
      gradeTurn(
        { message: 'm', checks: [check] },
        facts({ delivered: swapped, values: { openIssueKeys: keys } }),
      ).evidence.map((e) => e.fact),
    ).toEqual(['reply names ISS-10 before ISS-11']);
  });

  it('labeled reads the number after the label in its clause, or before it only when none follows, so a borrowed neighbour never counts', () => {
    const check: Check = { kind: 'labeled', label: /open/i, value: '{n}' };
    for (const ok of [
      'Open: 3.',
      '3 open issues',
      '| open | 3 |',
      'Open issues — 3 of them',
      'closed 1, 3 open and 0 drafts',
      '1 closed / 3 open / 0 drafts',
    ]) {
      expect(grade(check, ok), ok).toEqual([]);
    }
    for (const bad of [
      'Open: 30.',
      'Open: 13',
      'Open: 1, closed: 3',
      'closed 3. open 1',
      'open\n3',
      'Closed: 3 and open: 1',
      '3 closed and open: 1',
      '3 closed / 1 open',
    ]) {
      expect(grade(check, bad), bad).toEqual([
        { mode: 'unanswered', fact: 'reply does not pair /open/i with 3' },
      ]);
    }
  });

  it('linkTo needs an issue link whose segment is the filled id', () => {
    const check: Check = { kind: 'linkTo', issueId: '{id}' };
    expect(grade(check, `see /projects/qa/issues/${UUID}`)).toEqual([]);
    expect(grade(check, `see /projects/qa/issues/${DEAD}`)).toEqual([
      { mode: 'unanswered', fact: `no link to issue ${UUID}` },
    ]);
    expect(grade(check, 'ISS-7 is the one')).toEqual([
      { mode: 'unanswered', fact: `no link to issue ${UUID}` },
    ]);
  });
});
