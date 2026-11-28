// ISS-1483 (dev.857, dev.858): a sentence a room's agent is handed to relay never names the master, a
// team or a hand-off, because the agent repeats what it is handed and the person knows one voice. This
// renders every such string registered in `room-said.fixture.ts` and fails on one that does.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAMES_THE_HAND } from './room-voice.js';
import { ROOM_SAID, TAUGHT_NOT_SAID } from './room-said.fixture.js';

const told = (text: string) => TAUGHT_NOT_SAID.reduce((t, ok) => t.split(ok).join(''), text);

describe('the sentences a room agent relays', () => {
  it.each(ROOM_SAID.map((s) => [s.name, s] as const))(
    '%s names no master, team or hand-off',
    (_n, said) => {
      expect(existsSync(resolve(__dirname, '..', said.file))).toBe(true);
      const strings = said.render();
      expect(strings.length).toBeGreaterThan(0);
      for (const text of strings) expect(told(text)).not.toMatch(NAMES_THE_HAND);
    },
  );

  it('catches a string that does name one', () => {
    expect(told('Any other master or run reads it as withheld')).toMatch(NAMES_THE_HAND);
    expect(told("waits on the project's master to cut 0.1.0")).toMatch(NAMES_THE_HAND);
    expect(told('the team is fixing it')).toMatch(NAMES_THE_HAND);
    expect(told('ask with support.ask_master')).not.toMatch(NAMES_THE_HAND);
  });
});
