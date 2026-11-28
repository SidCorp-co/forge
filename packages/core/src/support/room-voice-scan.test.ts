// ISS-1483 (dev.857 to dev.859): a sentence a room's agent is handed to relay never names the master, a
// team or a hand-off as the one acting, because the agent repeats what it is handed and the person
// knows one voice. Three rounds fixed the strings a judge named and each missed the next, because the
// guard was a list someone kept. This one reads the source: every literal of the files a room reads
// is checked, so a new sentence is caught with no one remembering to list it.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAMES_THE_HAND, TAUGHT_NOT_SAID } from './room-voice.js';
import {
  ALLOWED,
  type Hit,
  literalsNaming,
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
