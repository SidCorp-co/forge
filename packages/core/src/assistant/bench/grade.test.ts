/**
 * ISS-1051 — every check kind goes red on the input planted for it and green on the good one,
 * and every failure mode has a case that produces it. A grader that never went red here is one
 * that cannot fail on the deployment either.
 */

import { describe, expect, it } from 'vitest';
import {
  emptyFallbackReply,
  errorFallbackReply,
  unverifiedFallbackReply,
} from '../../conversations/fallback-replies.js';
import {
  extractIssueLinks,
  FAILURE_MODES,
  type FailureMode,
  gradeTurn,
  isFallback,
  type TurnFacts,
  vietnameseWords,
} from './grade.js';
import type { Check } from './task.js';
import { SHIPPED_TASKS } from './tasks/index.js';
import type { Attempt, ToolCall } from './trail.js';

const UUID = '22222222-2222-4222-8222-222222222222';
const DEAD = '33333333-3333-4333-8333-333333333333';

const call = (name: string, args: string, over: Partial<ToolCall> = {}): ToolCall => ({
  name,
  arguments: args,
  argv: name === 'forge' ? (JSON.parse(args) as { argv: string[] }).argv : null,
  isError: false,
  durationMs: 1,
  ...over,
});
const forge = (...argv: string[]): ToolCall => call('forge', JSON.stringify({ argv }));
const attempt = (calls: ToolCall[] = [], over: Partial<Attempt> = {}): Attempt => ({
  chatLogId: 'log',
  calls,
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

const modesOf = (check: Check, f: TurnFacts): FailureMode[] =>
  gradeTurn({ message: 'm', checks: [check] }, f).modes;

describe('link checks', () => {
  it('linkShape fails a non-UUID segment and a hash-prefixed target, passes root-relative and absolute UUID links', () => {
    expect(
      modesOf({ kind: 'linkShape' }, facts({ delivered: `see /projects/qa/issues/ISS-7` })),
    ).toEqual(['wrong_link_shape']);
    expect(
      modesOf({ kind: 'linkShape' }, facts({ delivered: `see #/projects/qa/issues/${UUID}` })),
    ).toEqual(['wrong_link_shape']);
    expect(
      modesOf({ kind: 'linkShape' }, facts({ delivered: `see /projects/qa/issues/${UUID}` })),
    ).toEqual([]);
    expect(
      modesOf(
        { kind: 'linkShape' },
        facts({ delivered: `see https://forge-beta.sidcorp.co/projects/qa/issues/${UUID}` }),
      ),
    ).toEqual([]);
  });

  it('extractIssueLinks ignores API paths and unrelated hosts', () => {
    expect(extractIssueLinks(`GET https://api.example/api/projects/qa/issues/${UUID}`)).toEqual([]);
    expect(extractIssueLinks('https://github.com/x/y/issues/12')).toEqual([]);
    expect(extractIssueLinks(`/projects/qa/issues/${UUID}`)[0]).toMatchObject({
      hash: false,
      slug: 'qa',
      segment: UUID,
    });
  });

  it('linksResolve fails a dead lookup, passes a resolving one, and refuses a link with no lookup', () => {
    const text = `/projects/qa/issues/${DEAD} and /projects/qa/issues/${UUID}`;
    expect(
      modesOf(
        { kind: 'linksResolve' },
        facts({ delivered: text, lookups: { [DEAD]: 'dead', [UUID]: 'resolves' } }),
      ),
    ).toEqual(['dead_link']);
    expect(
      modesOf(
        { kind: 'linksResolve' },
        facts({ delivered: text, lookups: { [DEAD]: 'resolves', [UUID]: 'resolves' } }),
      ),
    ).toEqual([]);
    expect(() =>
      modesOf({ kind: 'linksResolve' }, facts({ delivered: text, lookups: {} })),
    ).toThrow(`no lookup outcome for linked issue ${DEAD}`);
  });
});

describe('text checks', () => {
  it('mustMatch fails when no pattern matches, fills literal placeholders, and reads a missing reply as unanswered', () => {
    expect(
      modesOf(
        { kind: 'mustMatch', patterns: [/thursday/i] },
        facts({ delivered: 'I do not know.' }),
      ),
    ).toEqual(['unanswered']);
    expect(
      modesOf(
        { kind: 'mustMatch', patterns: [/thursday/i] },
        facts({ delivered: 'Thursday 14:00.' }),
      ),
    ).toEqual([]);
    expect(
      modesOf(
        { kind: 'mustMatch', patterns: ['{projectName}'] },
        facts({ delivered: 'It is QA (beta).', values: { projectName: 'QA (beta)' } }),
      ),
    ).toEqual([]);
    expect(modesOf({ kind: 'mustMatch', patterns: [/x/] }, facts({ delivered: null }))).toEqual([
      'unanswered',
    ]);
  });

  it('the out-of-reach pattern reads a curly apostrophe as the assistant types it', () => {
    const task = SHIPPED_TASKS.find((t) => t.id === 'out-of-reach-tests');
    const check = task?.turns[0]?.checks[0];
    if (check?.kind !== 'mustMatch') throw new Error('matrix moved');
    expect(
      modesOf(check, facts({ delivered: 'I can’t run the test suite from this chat.' })),
    ).toEqual([]);
    expect(modesOf(check, facts({ delivered: "I can't run it." }))).toEqual([]);
  });

  it('mustNotMatch fails a reply matching a forbidden pattern', () => {
    expect(
      modesOf(
        { kind: 'mustNotMatch', patterns: [/all tests pass/i] },
        facts({ delivered: 'All tests pass!' }),
      ),
    ).toEqual(['unanswered']);
    expect(
      modesOf(
        { kind: 'mustNotMatch', patterns: [/all tests pass/i] },
        facts({ delivered: 'I cannot run them.' }),
      ),
    ).toEqual([]);
  });

  it('language is a diacritic heuristic: vi needs three marked words, en fails at two', () => {
    // cm:ignore CM001 — Vietnamese fixtures for the diacritic heuristic under test
    const vi = 'Dự án hiện có 3 issue đang mở.'; // i18n-allow: test fixture
    expect(modesOf({ kind: 'language', diacritics: 'vi' }, facts({ delivered: vi }))).toEqual([]);
    expect(
      modesOf(
        { kind: 'language', diacritics: 'vi' },
        facts({ delivered: 'The project has 3 open issues.' }),
      ),
    ).toEqual(['language_mismatch']);
    expect(
      modesOf(
        { kind: 'language', diacritics: 'en' },
        facts({ delivered: 'Nguyễn filed three issues.' }), // i18n-allow: test fixture
      ),
    ).toEqual([]);
    expect(
      modesOf({ kind: 'language', diacritics: 'vi' }, facts({ delivered: 'An English answer ế' })), // i18n-allow: test fixture
    ).toEqual(['language_mismatch']);
    expect(modesOf({ kind: 'language', diacritics: 'en' }, facts({ delivered: vi }))).toEqual([
      'language_mismatch',
    ]);
  });

  it('vietnameseWords ignores code spans, URLs and double-quoted spans', () => {
    // cm:ignore CM001 — Vietnamese fixtures for the diacritic heuristic under test
    expect(vietnameseWords('see `Dự án mở` at https://x/đề "hiện có" plain')).toBe(0); // i18n-allow: test fixture
    expect(vietnameseWords('Dự án hiện có ba')).toBe(4); // i18n-allow: test fixture
  });

  it('notFallback fails each fallback text the door builds, whatever the handle name', () => {
    for (const build of [errorFallbackReply, unverifiedFallbackReply, emptyFallbackReply]) {
      expect(isFallback(build('Forge Bot'))).toBe(true);
      expect(modesOf({ kind: 'notFallback' }, facts({ delivered: build('Forge Bot') }))).toEqual([
        'fallback_sent',
      ]);
    }
    expect(modesOf({ kind: 'notFallback' }, facts({ delivered: 'Here is your answer.' }))).toEqual(
      [],
    );
    expect(modesOf({ kind: 'notFallback' }, facts({ delivered: null }))).toEqual(['unanswered']);
  });
});

describe('budget checks', () => {
  it('maxSeconds fails a turn over its budget', () => {
    expect(modesOf({ kind: 'maxSeconds' }, facts({ seconds: 61, budgetSeconds: 60 }))).toEqual([
      'over_budget',
    ]);
    expect(modesOf({ kind: 'maxSeconds' }, facts({ seconds: 59, budgetSeconds: 60 }))).toEqual([]);
  });

  it('maxCalls and maxIterations count every attempt of the turn', () => {
    const two = [
      attempt([forge('issue'), forge('issue', 'ISS-7')], { iterations: 3 }),
      attempt([forge('x')], { iterations: 4 }),
    ];
    expect(modesOf({ kind: 'maxCalls', max: 2 }, facts({ attempts: two }))).toEqual([
      'over_budget',
    ]);
    expect(modesOf({ kind: 'maxCalls', max: 3 }, facts({ attempts: two }))).toEqual([]);
    expect(modesOf({ kind: 'maxIterations', max: 6 }, facts({ attempts: two }))).toEqual([
      'over_budget',
    ]);
    expect(modesOf({ kind: 'maxIterations', max: 7 }, facts({ attempts: two }))).toEqual([]);
  });
});

describe('trail checks', () => {
  it('toolsAllowed and toolsRequired', () => {
    const calls = [attempt([forge('issue'), call('forge_memory_search', '{}')])];
    expect(modesOf({ kind: 'toolsAllowed', tools: ['forge'] }, facts({ attempts: calls }))).toEqual(
      ['forbidden_tool'],
    );
    expect(
      modesOf(
        { kind: 'toolsAllowed', tools: ['forge', 'forge_memory_search'] },
        facts({ attempts: calls }),
      ),
    ).toEqual([]);
    expect(modesOf({ kind: 'toolsAllowed', tools: [] }, facts({ attempts: [attempt()] }))).toEqual(
      [],
    );
    expect(
      modesOf({ kind: 'toolsRequired', tools: ['forge_preferences'] }, facts({ attempts: calls })),
    ).toEqual(['missing_tool']);
    expect(
      modesOf({ kind: 'toolsRequired', tools: ['forge'] }, facts({ attempts: calls })),
    ).toEqual([]);
  });

  it('argvNotMatch ignores a help call on the verb: forge new -h files nothing', () => {
    const help = facts({ attempts: [attempt([forge('new', '-h')])] });
    expect(modesOf({ kind: 'argvNotMatch', pattern: /^new$/ }, help)).toEqual([]);
    expect(modesOf({ kind: 'noHelp' }, help)).toEqual(['help_roundtrip']);
  });

  it('argvNotMatch fails a forge verb matching the pattern', () => {
    expect(
      modesOf(
        { kind: 'argvNotMatch', pattern: /^new$/ },
        facts({ attempts: [attempt([forge('new', '-', '--title', 'x')])] }),
      ),
    ).toEqual(['forbidden_tool']);
    expect(
      modesOf(
        { kind: 'argvNotMatch', pattern: /^new$/ },
        facts({ attempts: [attempt([forge('issue', 'new')])] }),
      ),
    ).toEqual([]);
  });

  it('noHelp fails -h and --help', () => {
    expect(modesOf({ kind: 'noHelp' }, facts({ attempts: [attempt([forge('-h')])] }))).toEqual([
      'help_roundtrip',
    ]);
    expect(
      modesOf({ kind: 'noHelp' }, facts({ attempts: [attempt([forge('issue', '--help')])] })),
    ).toEqual(['help_roundtrip']);
    expect(
      modesOf(
        { kind: 'noHelp' },
        facts({ attempts: [attempt([forge('issue', '--status', 'open')])] }),
      ),
    ).toEqual([]);
  });

  it('noPlaceholder fails ISS-?, ISS-<n> and <…> arguments', () => {
    for (const bad of ['ISS-?', 'ISS-<n>', '<documentId>']) {
      expect(
        modesOf({ kind: 'noPlaceholder' }, facts({ attempts: [attempt([forge('issue', bad)])] })),
        bad,
      ).toEqual(['placeholder_argument']);
    }
    expect(
      modesOf({ kind: 'noPlaceholder' }, facts({ attempts: [attempt([forge('issue', 'ISS-7')])] })),
    ).toEqual([]);
  });

  it('noRepeatedCall fails the same name and arguments twice, across attempts too', () => {
    const twice = [attempt([forge('issue', 'ISS-7')]), attempt([forge('issue', 'ISS-7')])];
    expect(modesOf({ kind: 'noRepeatedCall' }, facts({ attempts: twice }))).toEqual([
      'repeated_call',
    ]);
    expect(
      modesOf(
        { kind: 'noRepeatedCall' },
        facts({ attempts: [attempt([forge('issue', 'ISS-7'), forge('issue', 'ISS-8')])] }),
      ),
    ).toEqual([]);
  });

  it('screenRepair fails two attempts for one send whether or not their replies are equal', () => {
    expect(
      modesOf(
        { kind: 'screenRepair' },
        facts({ attempts: [attempt([], { reply: 'a' }), attempt([], { reply: 'a' })] }),
      ),
    ).toEqual(['screen_repair']);
    expect(modesOf({ kind: 'screenRepair' }, facts({ attempts: [attempt()] }))).toEqual([]);
  });
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

describe('preferenceRows', () => {
  const moved = { field: 'answer_style', previousValue: 'default', newValue: 'bullets' };

  it('passes when the rows gained match the expectation field for field', () => {
    expect(
      modesOf(
        { kind: 'preferenceRows', rows: [{ field: 'answer_style', newValue: 'bullets' }] },
        facts({ preferenceRows: [moved] }),
      ),
    ).toEqual([]);
    expect(
      modesOf(
        { kind: 'preferenceRows', rows: [{ field: 'answer_style', previousValue: 'default' }] },
        facts({ preferenceRows: [moved] }),
      ),
    ).toEqual([]);
  });

  it('fails an expected row that is absent — a no-op write leaves none', () => {
    expect(
      modesOf(
        { kind: 'preferenceRows', rows: [{ field: 'answer_style', newValue: 'bullets' }] },
        facts({ preferenceRows: [] }),
      ),
    ).toEqual(['preference_not_moved']);
    expect(
      modesOf(
        { kind: 'preferenceRows', rows: [{ field: 'answer_style', newValue: 'concise' }] },
        facts({ preferenceRows: [moved] }),
      ),
    ).toEqual(['preference_not_moved', 'noop_trail_row']);
  });

  it('fails a row the expectation did not name', () => {
    const extra = { field: 'assistant_instructions', previousValue: null, newValue: 'be brief' };
    expect(
      modesOf(
        { kind: 'preferenceRows', rows: [{ field: 'answer_style', newValue: 'bullets' }] },
        facts({ preferenceRows: [moved, extra] }),
      ),
    ).toEqual(['noop_trail_row']);
  });
});

describe('the verdict', () => {
  it('carries one fact per mode and passes only with no mode', () => {
    const grade = gradeTurn(
      { message: 'm', checks: [{ kind: 'linkShape' }, { kind: 'noHelp' }] },
      facts({ delivered: '/projects/qa/issues/ISS-7', attempts: [attempt([forge('-h')])] }),
    );
    expect(grade.pass).toBe(false);
    expect(grade.modes).toEqual(['wrong_link_shape', 'help_roundtrip']);
    expect(grade.evidence.map((e) => e.fact)).toEqual([
      'issue segment is not a UUID: /projects/qa/issues/ISS-7',
      'forge -h',
    ]);
    expect(gradeTurn({ message: 'm', checks: [{ kind: 'noHelp' }] }, facts())).toEqual({
      pass: true,
      modes: [],
      evidence: [],
    });
  });

  it('every failure mode has a case above that produces it', () => {
    const produced: FailureMode[] = [
      ...modesOf({ kind: 'linkShape' }, facts({ delivered: '/projects/qa/issues/ISS-7' })),
      ...modesOf(
        { kind: 'linksResolve' },
        facts({ delivered: `/projects/qa/issues/${DEAD}`, lookups: { [DEAD]: 'dead' } }),
      ),
      ...modesOf({ kind: 'mustMatch', patterns: [/x/] }, facts({ delivered: 'y' })),
      ...modesOf({ kind: 'language', diacritics: 'vi' }, facts({ delivered: 'english' })),
      ...modesOf({ kind: 'notFallback' }, facts({ delivered: emptyFallbackReply('b') })),
      ...modesOf({ kind: 'maxSeconds' }, facts({ seconds: 99 })),
      ...modesOf({ kind: 'toolsAllowed', tools: [] }, facts({ attempts: [attempt([forge('x')])] })),
      ...modesOf({ kind: 'toolsRequired', tools: ['forge'] }, facts()),
      ...modesOf({ kind: 'noHelp' }, facts({ attempts: [attempt([forge('-h')])] })),
      ...modesOf({ kind: 'noPlaceholder' }, facts({ attempts: [attempt([forge('ISS-?')])] })),
      ...modesOf(
        { kind: 'noRepeatedCall' },
        facts({ attempts: [attempt([forge('a'), forge('a')])] }),
      ),
      ...modesOf({ kind: 'screenRepair' }, facts({ attempts: [attempt(), attempt()] })),
      ...modesOf(
        { kind: 'preferenceRows', rows: [] },
        facts({ preferenceRows: [{ field: 'answer_style', previousValue: 'a', newValue: 'b' }] }),
      ),
      ...modesOf({ kind: 'preferenceRows', rows: [{ field: 'answer_style' }] }, facts()),
    ];
    expect([...new Set(produced)].sort()).toEqual([...FAILURE_MODES].sort());
  });
});
