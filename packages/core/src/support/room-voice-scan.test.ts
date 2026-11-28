// ISS-1483 (dev.857 to dev.859): a sentence a room's agent is handed to relay never names the master, a
// team or a hand-off as the one acting, because the agent repeats what it is handed and the person
// knows one voice. Three rounds fixed the strings a judge named and each missed the next, because the
// guard was a list someone kept. This one reads the source: every literal of the files a room reads
// is checked, so a new sentence is caught with no one remembering to list it.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAID_ENTRIES, say } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import {
  isInternalHand,
  NAMES_THE_HAND,
  NO_PERSON,
  ROOM_SAID,
  roomSay,
  roomWho,
  TAUGHT_NOT_SAID,
} from './room-voice.js';
import {
  ALLOWED,
  type Hit,
  literalsNaming,
  NOT_ROOM_SAID,
  notRoomSaid,
  saidKeysNaming,
  scanSrc,
  stillNames,
} from './room-voice-scan.fixture.js';

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
  const source = readFileSync(resolve(SRC, '../../contracts/src/said-keys.ts'), 'utf8');
  const naming = saidKeysNaming(source);

  it('give every key that names an internal role the wording a room reads, or none is read by a room', () => {
    const unworded = naming
      .filter((k) => !notRoomSaid(k.key) && !(k.key in ROOM_SAID))
      .map((k) => `${k.key}  "${k.text.slice(0, 90)}"`);
    expect(unworded).toEqual([]);
  });

  it("keep every room wording in use, free of the roles, and with the page key's own variables", () => {
    const names = new Set(naming.map((k) => k.key));
    // the act of a judge, said as the room says it ('waits to have 0.4.0 judged'): no role named, a phrasing only
    const phrasing = new Set(['standing.act.judgeReleaseOn']);
    for (const [key, own] of Object.entries(ROOM_SAID)) {
      if (phrasing.has(key)) continue;
      expect(names.has(key), `${key} no longer names an internal role: delete its wording`).toBe(
        true,
      );
      expect(NAMES_THE_HAND.test(own) || /\brelease run\b/i.test(own), `${key}: ${own}`).toBe(
        false,
      );
      const entry = (SAID_ENTRIES as Record<string, { vars?: Record<string, string> }>)[key];
      for (const [, v] of own.matchAll(/\{(\w+)\}/g)) {
        expect(Object.keys(entry?.vars ?? {}), `${key} has no {${v}}`).toContain(v);
      }
    }
  });

  it('keep every NOT_ROOM_SAID group in use', () => {
    for (const group of Object.keys(NOT_ROOM_SAID)) {
      expect(
        naming.some((k) => k.key.startsWith(`${group}.`)),
        `${group} matches no key`,
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
    expect(roomWho(say('standing.who.you'))).toBe('You');
    expect(isInternalHand('Independent judge')).toBe(true);
  });

  it('read the room wording of an act, with its variables', () => {
    expect(roomSay(say('standing.act.judgeReleaseOn', { v: '0.4.0', environment: 'test' }))).toBe(
      'have 0.4.0 judged on test',
    );
  });

  it('turn red on a planted said-key, naming the key', () => {
    const planted = saidKeysNaming(
      '\t"issues.rule.planted": { en: "waits on Independent judge to judge {v}" },\n',
    );
    expect(planted.map((k) => k.key)).toEqual(['issues.rule.planted']);
    expect((planted[0]?.key ?? '') in ROOM_SAID).toBe(false);
    expect(notRoomSaid('issues.rule.planted')).toBe(false);
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
