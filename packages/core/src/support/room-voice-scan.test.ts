// @direct-test-of packages/contracts/src/said-keys.ts
// ISS-1483 (dev.857 to dev.859): a sentence a room's agent is handed to relay never names the master, a
// team or a hand-off as the one acting, because the agent repeats what it is handed and the person
// knows one voice. Three rounds fixed the strings a judge named and each missed the next, because the
// guard was a list someone kept. This one reads the source: every literal of the files a room reads
// is checked, so a new sentence is caught with no one remembering to list it.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Forecast } from '@forge/contracts/forecast';
import {
  SAID_ENTRIES,
  type Said,
  type SaidEntry,
  type SaidKey,
  type SaidValue,
  say,
  verbatim,
} from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { notReadyOf } from './ops-release-holds.js';
import { INTERNAL_RECORD, withoutReferences } from './room-read-words.js';
import {
  INTERNAL_WORDS,
  isInternalHand,
  NAMES_THE_HAND,
  NEUTRAL_WAIT,
  NO_PERSON,
  ROOM_PLAIN,
  ROOM_SAID,
  ROOM_VARS,
  roomPerson,
  roomReads,
  roomSay,
  roomWaits,
  roomWho,
  TAUGHT_NOT_SAID,
} from './room-voice.js';
import {
  ALLOWED,
  ALLOWED_RENDERS,
  directRenders,
  directRendersIn,
  type Hit,
  isPlainCandidate,
  literalsNaming,
  scanSrc,
  stillNames,
} from './room-voice-scan.fixture.js';
import { etaOf } from './shared-picture.js';
import * as workCards from './work-cards.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const named = (hits: Hit[]) => hits.map((h) => `${h.file}:${h.line}  "${h.text.slice(0, 120)}"`);

describe('the sentences a room reads', () => {
  const raw = scanSrc(SRC);

  it('name no master, team or hand-off as the one acting, outside the allowed list', () => {
    expect(named(raw.filter(stillNames))).toEqual([]);
  });

  it('keep every allowed entry in use, so a deleted sentence takes its entry with it', () => {
    for (const a of ALLOWED) {
      const used = raw.some(
        (h) => (!a.file || a.file === h.file) && (!a.phrase || h.text.includes(a.phrase)),
      );
      expect(used, `${a.file ?? 'any file'} ${a.phrase ?? ''} matches no literal`).toBe(true);
    }
  });

  it('turn red on a planted sentence, naming its file and its words', () => {
    const planted = literalsNaming(
      'support/rules.ts',
      'export const note = (key: string) => `${key} will not be done: the team declined it.`;\n',
    );
    expect(planted).toHaveLength(1);
    expect(stillNames(planted[0] as Hit)).toBe(true);
    expect(named(planted)[0]).toContain('support/rules.ts:1');
    expect(named(planted)[0]).toContain('the team declined it');
  });

  it('turn red on each shape the judge found, and pass what says what happened', () => {
    for (const bad of [
      'was answered by the team: nothing was changed',
      'It never will: the team dropped that work.',
      'what the team said or shipped',
      'The master fixed it for new exports',
      'a restart will bring it back',
    ]) {
      expect(
        literalsNaming('support/x.ts', `export const s = ${JSON.stringify(bad)};`),
      ).toHaveLength(1);
    }
    for (const good of [
      'It was declined, and nothing more will come of it.',
      'ask with support.ask_master',
      `${TAUGHT_NOT_SAID[0]}`,
    ]) {
      const hits = literalsNaming('support/x.ts', `export const s = ${JSON.stringify(good)};`);
      expect(hits.filter(stillNames)).toEqual([]);
    }
    expect('the team is fixing it').toMatch(NAMES_THE_HAND);
  });
});

describe('the said-keys a room reads (ISS-1483)', () => {
  const entries = Object.entries(SAID_ENTRIES) as [SaidKey, SaidEntry][];
  const DEVICE = 'sid-xeon-1-dev';
  const PANE = 'forge-master-forge';
  const DIALOG = 'Trust this folder? 1. Yes';
  // a nested sentence that names the master pane and its device, so a key that renders its nested var as it is shows it
  const nested = {
    key: 'masters.act.answerDialog',
    vars: { pane: { key: 'masters.who.whoeverReachesPane' }, text: DIALOG },
  } as Said;
  const fixtureValue = (kind: string, said = false): SaidValue => {
    if (said) return 'Lan Tran';
    const fixed: Record<string, SaidValue> = {
      name: DEVICE,
      text: `${PANE} ${DIALOG}`,
      count: 3,
      version: '0.4.0',
      key: 'ISS-1',
      permission: 'project.write',
      role: 'project.write',
      date: '2026-11-28',
      instant: '2026-11-28T08:00:00.000Z',
      status: 'in_progress',
      statusLabel: 'in_progress',
      step: 'build',
      health: 'ok',
      code: 'MASTER_PANE_DIALOG',
      agreement: 'is',
    };
    if (kind === 'said' || kind === 'said?') return nested;
    if (kind.startsWith('said')) return [nested];
    return fixed[kind] ?? PANE;
  };
  const fixtureOf = (key: SaidKey, entry: SaidEntry): Said => ({
    key,
    vars: Object.fromEntries(
      Object.entries(entry.vars ?? {}).map(([n, k]) => [
        n,
        fixtureValue(k, `${key}.${n}` in ROOM_VARS),
      ]),
    ),
  });

  it('read every key of the registry with no role, device, pane, dialog or actor in it, and no key a later change adds can break that', () => {
    const bad: string[] = [];
    for (const [key, entry] of entries) {
      const said = roomSay(fixtureOf(key, entry));
      const leaks =
        NAMES_THE_HAND.test(said) ||
        INTERNAL_WORDS.test(said) ||
        /\brelease run\b/i.test(said) ||
        said.includes(DEVICE) ||
        said.includes(PANE) ||
        said.includes(DIALOG) ||
        /\bno person\b/i.test(said);
      if (leaks) bad.push(`${key}: ${said}`);
    }
    expect(bad).toEqual([]);
  });

  it('read a key with no room wording as one fixed sentence', () => {
    const planted = {
      key: 'issues.standing.act.planted' as SaidKey,
      vars: { why: 'the master said hold' },
    };
    expect(roomSay(planted)).toBe(NEUTRAL_WAIT);
    expect(roomWho(planted)).toBe(NO_PERSON);
    expect(roomWaits(planted, planted)).toBe('is waiting on something outside this thread');
    // every key a room reads is named: nothing reaches a room by a pattern
    for (const [key] of entries) {
      expect(roomReads(key) === (key in ROOM_SAID || ROOM_PLAIN.has(key)), key).toBe(true);
    }
  });

  it('say the master pane waiting on a dialog as the fixed sentence, naming no device, pane or dialog', () => {
    // masters/read.ts:waitingOnDialog builds exactly this who and act, and forecast/facts.ts:projectWaitOf spreads it into every issue's wait
    const who = { key: 'forecast.who.whoeverReaches', vars: { device: DEVICE } } as Said;
    const act = {
      key: 'masters.act.answerDialog',
      vars: { pane: { key: 'masters.who.whoeverReachesPane' }, text: DIALOG },
    } as Said;
    const reason = {
      key: 'forecast.reason.masterDialog',
      vars: { rule: 'MASTER_PANE_DIALOG' },
    } as Said;
    const said = roomWaits(who, act, reason);
    expect(said).toBe('is waiting on something outside this thread');
    for (const leak of [DEVICE, PANE, DIALOG, 'master', 'dialog', 'pane']) {
      expect(said).not.toContain(leak);
    }
    const paused = { kind: 'paused', says: { who, act, reason } } as unknown as Forecast;
    expect(etaOf(paused).says).toBe('no date: it is waiting on something outside this thread');
  });
});

describe('the wording a room reads (ISS-1483)', () => {
  const entries = Object.entries(SAID_ENTRIES) as [SaidKey, SaidEntry][];

  it("say a park reason's words to no room", () => {
    const why = verbatim(
      'the master said hold it for the orchestrator, a qa run and a builder run',
    );
    for (const s of [
      say('issues.standing.act.resumeOnce', { why }),
      say('issues.rule.parked', { why }),
      say('issues.rule.parkedAsked', { why }),
      say('issues.rule.parkedBehind', { key: 'ISS-9', why }),
    ]) {
      const said = roomSay(s);
      expect(said, s.key).not.toMatch(/master|orchestrator|qa run|builder|hold it/i);
    }
    expect(roomSay(say('issues.rule.parked', { why }))).toBe(
      'it is paused and will resume when the condition it waits on is met',
    );
  });

  it('read each wait as a plain clause, never "no person"', () => {
    const judge = say('standing.act.judgeReleaseOn', { v: '0.4.0', environment: 'test' });
    expect(roomWaits(say('standing.who.releaseGate'), judge)).toBe(
      'is waiting to have 0.4.0 judged on test',
    );
    // "You" and "Nobody" name no person in a room (no viewer, and nobody is no one to wait on)
    expect(roomWaits(say('standing.who.you'), say('issues.standing.act.answer'))).toBe(
      'is waiting to answer a question',
    );
    expect(roomWho(say('standing.who.you'))).toBe(NO_PERSON);
  });

  it('hold ROOM_PLAIN to the rule that lists it, every key real', () => {
    for (const key of ROOM_PLAIN) {
      const entry = (SAID_ENTRIES as Record<string, SaidEntry>)[key];
      expect(entry, `${key} is not in the registry`).toBeDefined();
      expect(isPlainCandidate(key, entry as SaidEntry), `${key} is no longer a plain key`).toBe(
        true,
      );
    }
    for (const [key, entry] of entries) {
      if (isPlainCandidate(key, entry)) {
        expect(
          ROOM_PLAIN.has(key),
          `${key} reads plain: list it in room-plain-keys.ts to say it`,
        ).toBe(true);
      }
    }
  });

  it("keep every room wording in use, free of the roles, and with the page key's own variables", () => {
    for (const [key, own] of Object.entries(ROOM_SAID)) {
      const entry = (SAID_ENTRIES as Record<string, SaidEntry>)[key];
      expect(entry, `${key} is not in the registry`).toBeDefined();
      expect(
        NAMES_THE_HAND.test(own) || INTERNAL_WORDS.test(own) || /\bno person\b/i.test(own),
        `${key}: ${own}`,
      ).toBe(false);
      for (const [, v] of own.matchAll(/\{(\w+)\}/g)) {
        const kind = entry?.vars?.[v as string];
        expect(kind, `${key} has no {${v}}`).toBeDefined();
        expect(
          ['text', 'name', 'health'].includes(kind as string) ? `${key}.${v}` in ROOM_VARS : true,
          `${key} says {${v}}, words a person or a run wrote, with no ROOM_VARS reason`,
        ).toBe(true);
      }
    }
    for (const name of Object.keys(ROOM_VARS)) {
      expect(
        entries.some(([k, e]) => Object.keys(e.vars ?? {}).some((n) => `${k}.${n}` === name)),
        `${name} names no var`,
      ).toBe(true);
    }
  });

  it('say no name for an actor that is an internal hand', () => {
    for (const key of [
      'standing.who.master',
      'standing.who.projectMaster',
      'standing.who.steward',
      'standing.who.independentJudge',
      'standing.who.releaseRun',
      'standing.who.releaseGate',
    ] as const) {
      expect(roomWho(say(key)), key).toBe(NO_PERSON);
    }
    expect(isInternalHand('Independent judge')).toBe(true);
  });

  it('read the room wording of an act, with its variables', () => {
    expect(roomSay(say('standing.act.judgeReleaseOn', { v: '0.4.0', environment: 'test' }))).toBe(
      'have 0.4.0 judged on test',
    );
  });

  it('find no direct render of a said-key in a room read outside the allowed list, and turn red on a planted one', () => {
    const direct = directRenders(SRC);
    const left = direct.filter((h) => !ALLOWED_RENDERS.some((a) => a.file === h.file));
    expect(named(left)).toEqual([]);
    for (const a of ALLOWED_RENDERS) {
      expect(
        direct.some((h) => h.file === a.file),
        `${a.file} no longer renders directly: delete its entry`,
      ).toBe(true);
    }
    const planted = directRendersIn(
      'support/x.ts',
      "import { sayEn } from '@forge/contracts/said';\nexport const s = (w: Said) => sayEn(w.says.act);\n",
    );
    expect(named(planted)[0]).toContain('support/x.ts:2');
  });

  it('read a literal inside a template expression, and the words the judge found', () => {
    expect(
      literalsNaming(
        'support/x.ts',
        'export const s = (q: string) => `' +
          '$' +
          '{q} is owed by ' +
          '$' +
          "{q ? 'a check' : 'the master'}.`;",
      ),
    ).toHaveLength(1);
    for (const bad of [
      'the project side',
      'passed to ops',
      'the engineering team',
      'ask the developers',
    ]) {
      expect(
        literalsNaming('support/x.ts', `export const s = ${JSON.stringify(bad)};`),
        bad,
      ).toHaveLength(1);
    }
  });
});

describe('what a room read hands the agent (ISS-1483)', () => {
  it('read a wait on Nobody for the usage limit as waiting it out, never "on Nobody"', () => {
    const wait = (act: Said) => roomWaits(say('standing.who.nobody'), act);
    expect(wait(say('forecast.act.waitUsage'))).toBe('is waiting for the usage limit to reset');
    expect(wait(say('forecast.act.waitOut', { reason: 'rate limit' }))).toBe(
      'is waiting out the rate limit',
    );
    expect(roomPerson(say('standing.who.nobody'))).toBeNull();
    expect(roomPerson(say('standing.who.named', { name: 'Lan' }))).toBe('Lan');
  });

  it('say no sha and no error code to a room, whichever key carries one', () => {
    const planted = {
      key: 'issues.standing.act.moveOnRefused' as SaidKey,
      vars: { code: 'RELEASE_RECORD_MISSING' },
    };
    const mark = {
      key: 'issues.rule.markOwed' as SaidKey,
      vars: { n: 4, sha: '9e174d4534ab' },
    };
    const merged = {
      key: 'issues.standing.act.markMerged' as SaidKey,
      vars: { n: 4, sha: '9e174d4534ab' },
    };
    for (const s of [planted, mark, merged]) {
      expect(roomSay(s), s.key).not.toMatch(/RELEASE_RECORD|9e174d4|\{|!4/);
      expect(roomReads(s.key), s.key).toBe(true);
    }
    // the registry-wide rule: a room-read template names no {sha} or {code}, so a key added tomorrow cannot
    const templates = [
      ...[...ROOM_PLAIN].map((k) => [k, (SAID_ENTRIES as Record<string, SaidEntry>)[k]?.en ?? '']),
      ...Object.entries(ROOM_SAID),
    ];
    for (const [key, text] of templates) {
      expect(text, `${key} says a sha or a code to a room`).not.toMatch(/\{(?:sha|code)\}/);
    }
    // and a plain candidate that carries one is not plain
    expect(
      isPlainCandidate('issues.rule.planted', {
        en: 'merged at {sha}',
        vars: { sha: 'code' },
      } as SaidEntry),
    ).toBe(false);
  });

  it('mark a note as an internal record and strip its handles', () => {
    expect(INTERNAL_RECORD).toMatch(/internal record/);
    expect(INTERNAL_RECORD).toMatch(/never name who did it/);
    const note =
      'ISS-1483 landed at 9e174d4534 (RELEASE_RECORD_MISSING), packages/core/src/x.ts, BC-3';
    const clean = withoutReferences(note);
    for (const handle of ['ISS-1483', '9e174d4534', 'RELEASE_RECORD_MISSING', 'x.ts', 'BC-3']) {
      expect(clean, handle).not.toContain(handle);
    }
    expect(withoutReferences('it works now')).toBe('it works now');
  });

  it('teach the internal-record rule on the issues card the agent reads', () => {
    const card = JSON.stringify(workCards.WORK_ACT_CARDS.issues);
    expect(card).toMatch(/internal records/);
    expect(card).toMatch(/never quote a key, sha or code/);
    expect(card).not.toMatch(/says who owes what/);
  });

  it('say one rendering of a release gate, in the notReady reasons as in the blockers', () => {
    const gate = {
      kind: 'blocker',
      sentence: 'Blocked by ISS-9, landed and waiting for the independent judge',
      says: { sentence: say('issues.blocker.landedOne', { keys: 'ISS-9' }) },
      issues: ['ISS-4'],
    };
    const detail = {
      gates: [gate],
      contents: [{ issues: [{ key: 'ISS-4', title: 'T', proof: 'proven' }] }],
    } as unknown as Parameters<typeof notReadyOf>[0];
    const [row] = notReadyOf(detail);
    expect(row?.why).toBe(roomSay(gate.says.sentence));
    expect(row?.why).not.toMatch(NAMES_THE_HAND);
  });
});
