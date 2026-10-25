// ISS-1229 r40, judge-111: the room's door and the room's card read one table, so the refusal the
// assistant reads names where the act is done, as the card the person reads does.

import {
  DONE_AT_A_TERMINAL,
  ROOM_VERBS,
  roomOpens,
  whereItIsDone,
} from '@forge/contracts/room-verbs';
import { describe, expect, it } from 'vitest';
import { admitVerb, CHAT_JOB_VERBS } from './forge-cli-argv.js';

describe('admitVerb', () => {
  it('runs every verb the room table opens, and its help', () => {
    expect(CHAT_JOB_VERBS).toBe(ROOM_VERBS);
    for (const verb of ROOM_VERBS) expect(admitVerb([verb]), verb).toBeNull();
    expect(admitVerb(['-h'])).toBeNull();
    expect(admitVerb(['knowledge', 'search', 'billing'])).toBeNull();
    expect(admitVerb(['knowledge', '-h'])).toBeNull();
  });

  it("refuses a status move by name and says it is moved on the issue's page", () => {
    const refusal = admitVerb(['advance', 'ISS-1', '--set', 'in_progress']);
    expect(refusal).toMatch(/^`forge advance` is not open from chat\./);
    expect(refusal).toContain("A status is moved on the issue's page.");
    expect(whereItIsDone('advance')).toBe("A status is moved on the issue's page.");
  });

  it('says every other closed act is done at a terminal', () => {
    for (const argv of [['deploy'], ['claim', 'ISS-1'], ['doctor']]) {
      const refusal = admitVerb(argv) as string;
      expect(refusal, argv[0]).toContain('is not open from chat');
      expect(refusal.endsWith(DONE_AT_A_TERMINAL), argv[0]).toBe(true);
    }
    const write = admitVerb(['knowledge', 'write', 'billing', '-']) as string;
    expect(write).toBe(
      `\`forge knowledge write\` is not open from chat; list/get/search are. ${DONE_AT_A_TERMINAL}`,
    );
  });

  it('agrees with the table on every call it is asked about', () => {
    const calls: [string, string?][] = [
      ['issue'],
      ['advance'],
      ['knowledge', 'get'],
      ['knowledge', 'delete'],
      ['record', 'plan'],
    ];
    for (const [verb, sub] of calls) {
      expect(admitVerb(sub ? [verb, sub] : [verb]) === null, verb).toBe(roomOpens(verb, sub));
    }
  });
});
