// Whether the readings a release recorded show it live (ISS-1282). Every case plants the readings
// the rule is about and watches the judgement name its own reason: the failure this exists to
// catch is "the site is up, the deploy reported success, and it is serving the previous build",
// and the one it must not cause is closing a roster on a reading nobody took.

import { describe, expect, it } from 'vitest';
import {
  type JudgedBinding,
  type JudgeInput,
  judgeReadings,
  RELEASE_READING_MAX_AGE_MS,
} from './reading-judge.js';
import type { ReleaseReading } from './readings.js';
import { NOTHING_TO_COMPARE } from './verify.js';

/** Whole object names. A claim under test may be nothing else. */
const NEW = 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e';
const OLD = 'a12b34c5d6e7f8091a2b3c4d5e6f708192a3b4c5';
const SAME = 'c0ffee1234567890abcdef1234567890abcdef12';
const ELSEWHERE = 'dead0beef1234567890abcdef1234567890abcde';
const FLAP = 'f1a99109876543210fedcba9876543210fedcba9';
const SHORT = 'b853f813d';

const T0 = Date.parse('2026-10-08T10:00:00.000Z');
const SECOND = 1000;

const A: JudgedBinding = { bindingId: 'a', name: 'coolify [web] a', stableReads: 2 };
const B: JudgedBinding = { bindingId: 'b', name: 'coolify [api] b', stableReads: 2 };

type Say = string | null | 'down' | 'disagree' | 'silent';

function stateOf(say: Say) {
  const url = 'https://probe.test/version';
  if (say === 'down') {
    return {
      health: 'down' as const,
      identity: null,
      answeredBy: [],
      readings: [`${url} answered http 503`],
      unhealthy: [`${url} answered http 503`],
      unidentified: [],
      disagreement: null,
    };
  }
  if (say === 'disagree') {
    return {
      health: 'up' as const,
      identity: null,
      answeredBy: [
        { url, commit: OLD },
        { url, commit: NEW },
      ],
      readings: [`${url} -> ${OLD}`, `${url} -> ${NEW}`],
      unhealthy: [],
      unidentified: [],
      disagreement: [OLD, NEW],
    };
  }
  if (say === 'silent' || say === null) {
    return {
      health: 'up' as const,
      identity: null,
      answeredBy: [],
      readings: [`${url} answered 200 and \`commit\` held no commit`],
      unhealthy: [],
      unidentified: [`${url} answered 200 and \`commit\` held no commit`],
      disagreement: null,
    };
  }
  return {
    health: 'up' as const,
    identity: say,
    answeredBy: [{ url, commit: say }],
    readings: [`${url} -> ${say}`],
    unhealthy: [],
    unidentified: [],
    disagreement: null,
  };
}

let seq = 0;
/** One look: what each named binding said, `seconds` after the first one. */
function look(seconds: number, says: Record<string, Say>): ReleaseReading {
  seq += 1;
  return {
    id: `reading-${seq}`,
    runId: 'run',
    takenAt: new Date(T0 + seconds * SECOND),
    takenBy: 'agent',
    unread: [],
    bindings: Object.entries(says).map(([bindingId, say]) => ({
      bindingId,
      name: bindingId === 'a' ? A.name : B.name,
      state: stateOf(say),
    })),
  };
}

const judge = (over: Partial<JudgeInput>) =>
  judgeReadings({
    bindings: [{ ...A }],
    readings: [],
    commitsBefore: { a: OLD, b: OLD },
    claim: NEW,
    now: T0 + 60 * SECOND,
    ...over,
  });

function refusal(over: Partial<JudgeInput>): string {
  const out = judge(over);
  if (out.ok) throw new Error('expected a refusal, got a green');
  return out.reason;
}

describe('a release that is live', () => {
  it('closes on the consecutive readings that show the claimed commit, and names the ones it rested on', () => {
    const first = look(10, { a: NEW });
    const second = look(20, { a: NEW });

    const out = judge({ readings: [first, second] });

    expect(out).toEqual({ ok: true, moved: true, identity: NEW, evidence: [first.id, second.id] });
  });

  it('goes green on a deploy that lands late, with no failed attempt in between', () => {
    const early = look(5, { a: OLD });
    const stillOld = look(15, { a: OLD });
    const arrived = look(40, { a: NEW });
    const held = look(50, { a: NEW });

    expect(judge({ readings: [early] }).ok).toBe(false);
    expect(judge({ readings: [early, stillOld] }).ok).toBe(false);
    expect(judge({ readings: [early, stillOld, arrived] }).ok).toBe(false);
    expect(judge({ readings: [early, stillOld, arrived, held] })).toMatchObject({
      ok: true,
      evidence: [arrived.id, held.id],
    });
  });

  // ISS-1199 — `commitBefore` is read when the batch is OPENED, so a batch opened after its own
  // deploy shipped captured the released commit. The claim is the whole proof where one is made.
  it('closes where the deployment already served the commit the release names, saying it did not move', () => {
    const out = judge({
      readings: [look(10, { a: SAME }), look(20, { a: SAME })],
      commitsBefore: { a: SAME },
      claim: SAME,
    });

    expect(out).toMatchObject({ ok: true, moved: false, identity: SAME });
  });

  it('asks only that the build moved where the release names no commit', () => {
    const out = judge({ readings: [look(10, { a: NEW }), look(20, { a: NEW })], claim: null });

    expect(out).toMatchObject({ ok: true, moved: true });
  });

  // ISS-1161 — the reading may abbreviate the claim, never the reverse.
  it('reads a whole claim against the abbreviation the deployment reports', () => {
    const out = judge({ readings: [look(10, { a: SHORT }), look(20, { a: SHORT })] });

    expect(out).toMatchObject({ ok: true, identity: SHORT });
  });
});

describe('a release that is not shown live', () => {
  it('is refused with no reading at all, saying to look and not that the deploy failed', () => {
    const out = judge({});

    expect(out).toEqual({
      ok: false,
      live: null,
      reason: expect.stringContaining('no reading of coolify [web] a is recorded on this batch'),
    });
    expect(out.ok === false && out.reason).toContain('call `look`');
  });

  it('stays a RED where a healthy site still serves the build the batch opened on', () => {
    const readings = [look(10, { a: OLD }), look(20, { a: OLD })];

    expect(refusal({ readings, claim: NEW })).toContain('the live build is unchanged');
    expect(refusal({ readings, claim: null })).toContain('the live build is unchanged');
    expect(refusal({ readings, claim: NEW })).toContain(`the release pushed ${NEW}`);
  });

  it('names both commits where the live build is neither the old one nor the claimed one', () => {
    const reason = refusal({ readings: [look(10, { a: ELSEWHERE }), look(20, { a: ELSEWHERE })] });

    expect(reason).toContain(ELSEWHERE);
    expect(reason).toContain(NEW);
  });

  it('is refused naming the application as not answering where health is down, before identity', () => {
    const reason = refusal({ readings: [look(10, { a: NEW }), look(20, { a: 'down' })] });

    expect(reason).toContain('the application is not answering');
    expect(reason).toContain('http 503');
  });

  it('names the probe declaration, not the deploy, where the site is healthy and reports no commit', () => {
    const reason = refusal({ readings: [look(10, { a: 'silent' }), look(20, { a: 'silent' })] });

    expect(reason).toContain('probe declaration');
    expect(reason).not.toContain('the application is not answering');
  });

  it('calls a fleet that disagrees a rollout, not a failed build', () => {
    const reason = refusal({
      readings: [look(10, { a: 'disagree' }), look(20, { a: 'disagree' })],
    });

    expect(reason).toContain('the fleet disagrees');
    expect(reason).toContain('a rollout that has not finished');
  });

  it('has nothing to compare where no commit is claimed and none was recorded before', () => {
    const out = judge({
      readings: [look(10, { a: NEW }), look(20, { a: NEW })],
      claim: null,
      commitsBefore: {},
    });

    expect(out).toEqual({ ok: false, live: NEW, reason: NOTHING_TO_COMPARE });
  });

  it('is not satisfied by a reading of an earlier commit among the last ones, even where the newest is right', () => {
    const readings = [look(10, { a: NEW }), look(20, { a: OLD }), look(30, { a: NEW })];

    const reason = refusal({ readings });

    expect(reason).toContain('do not all show the build this release pushed');
    expect(reason).toContain(OLD);
  });

  it('does not believe readings that hold no steady identity where no commit is claimed', () => {
    const readings = [look(10, { a: NEW }), look(20, { a: FLAP }), look(30, { a: NEW })];

    const reason = refusal({ readings, claim: null });

    expect(reason).toContain('a rollout still moving');
    expect(judge({ readings: [...readings, look(40, { a: NEW })], claim: null }).ok).toBe(true);
  });
});

describe('how many readings, and how old', () => {
  it('asks for as many consecutive readings as the binding declares, no fewer', () => {
    const one = look(10, { a: NEW });
    const reason = refusal({ readings: [one] });

    expect(reason).toContain('1 of the 2 consecutive readings');
    expect(reason).toContain('call `look` again');
    expect(judge({ readings: [one], bindings: [{ ...A, stableReads: 1 }] }).ok).toBe(true);
  });

  it('counts only the newest readings: ten is believed on its last ten, not its first', () => {
    const tenAt = { ...A, stableReads: 10 };
    const old = Array.from({ length: 9 }, (_, i) => look(i, { a: NEW }));

    expect(refusal({ readings: old, bindings: [tenAt] })).toContain('9 of the 10 consecutive');
    const ten = [...old, look(9, { a: NEW })];
    expect(judge({ readings: ten, bindings: [tenAt] })).toMatchObject({ ok: true });
    const spoiled = [look(0, { a: OLD }), ...ten];
    expect(judge({ readings: spoiled, bindings: [tenAt] }).ok).toBe(true);
  });

  it('believes a reading exactly as old as the bound allows, and not one second older', () => {
    const readings = [look(0, { a: NEW }), look(1, { a: NEW })];
    const at = T0 + 1 * SECOND + RELEASE_READING_MAX_AGE_MS;

    expect(judge({ readings, now: at }).ok).toBe(true);
    const stale = refusal({ readings, now: at + 1 });
    expect(stale).toContain('minutes old');
    expect(stale).toContain('call `look` again');
  });

  it('says a stale reading is stale before it says anything about what it showed', () => {
    const readings = [look(0, { a: OLD }), look(1, { a: OLD })];

    const reason = refusal({ readings, now: T0 + 60 * 60_000 });

    expect(reason).toContain('minutes old');
    expect(reason).not.toContain('unchanged');
  });

  it('is closed again by a fresh look after a stale one', () => {
    const stale = [look(0, { a: NEW }), look(1, { a: NEW })];
    const later = T0 + 40 * 60_000;
    const fresh = [look(39 * 60, { a: NEW }), look(39 * 60 + 30, { a: NEW })];

    expect(judge({ readings: stale, now: later }).ok).toBe(false);
    expect(judge({ readings: [...stale, ...fresh], now: later }).ok).toBe(true);
  });
});

describe('every live binding on its own reading', () => {
  const both = [{ ...A }, { ...B }];

  it('is refused naming the binding whose readings do not confirm, and closes once both do', () => {
    const readings = [look(10, { a: NEW, b: OLD }), look(20, { a: NEW, b: OLD })];

    const out = judge({ bindings: both, readings });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain(`${B.name}: the live build is unchanged`);
    expect(out.ok === false && out.reason).not.toContain(`${A.name}:`);

    const landed = [...readings, look(30, { a: NEW, b: NEW }), look(40, { a: NEW, b: NEW })];
    expect(judge({ bindings: both, readings: landed })).toMatchObject({ ok: true, moved: true });
  });

  it('names every binding that is refused, each by its own reason', () => {
    const reason = refusal({
      bindings: both,
      readings: [look(10, { a: OLD, b: 'down' }), look(20, { a: OLD, b: 'down' })],
    });

    expect(reason).toContain(`${A.name}: the live build is unchanged`);
    expect(reason).toContain(`${B.name}: the application is not answering`);
  });

  it('counts a binding no reading mentions as unread, not as confirmed by its sibling', () => {
    const readings = [look(10, { a: NEW }), look(20, { a: NEW })];

    const reason = refusal({ bindings: both, readings });

    expect(reason).toContain(`no reading of ${B.name} is recorded`);
  });

  it('judges each binding against the build it served when the batch opened', () => {
    const readings = [look(10, { a: NEW, b: NEW }), look(20, { a: NEW, b: NEW })];

    const reason = refusal({
      bindings: both,
      readings,
      claim: null,
      commitsBefore: { a: OLD },
    });

    expect(reason).toBe(`${B.name}: ${NOTHING_TO_COMPARE}`);
    expect(
      judge({ bindings: both, readings, claim: null, commitsBefore: { a: OLD, b: OLD } }).ok,
    ).toBe(true);
  });

  it('holds one binding to its own stableReads and not its sibling’s', () => {
    const readings = [look(10, { a: NEW, b: NEW }), look(20, { a: NEW, b: NEW })];

    const reason = refusal({
      bindings: [{ ...A }, { ...B, stableReads: 3 }],
      readings,
    });

    expect(reason).toContain(`${B.name}: 2 of the 3 consecutive readings`);
  });

  it('is judged stale by the binding whose newest reading is old, though the other’s is fresh', () => {
    const readings = [
      look(0, { a: NEW, b: NEW }),
      look(1, { a: NEW, b: NEW }),
      look(20 * 60, { a: NEW }),
      look(20 * 60 + 1, { a: NEW }),
    ];

    const reason = refusal({ bindings: both, readings, now: T0 + 21 * 60_000 });

    expect(reason).toContain(`${B.name}: the newest reading of ${B.name} is`);
    expect(reason).not.toContain(`${A.name}:`);
  });

  it('names each reading once as evidence, whichever binding it served', () => {
    const readings = [look(10, { a: NEW, b: NEW }), look(20, { a: NEW, b: NEW })];

    const out = judge({ bindings: both, readings });

    expect(out).toMatchObject({ ok: true, evidence: readings.map((r) => r.id) });
  });
});

describe('what it will not judge', () => {
  it('throws where no binding was named, because nothing to judge is nothing proved', () => {
    expect(() => judge({ bindings: [] })).toThrow('no binding was named to judge');
  });

  it('is judged by the clock it is handed and by no other', () => {
    const readings = [look(0, { a: NEW }), look(1, { a: NEW })];

    expect(judge({ readings, now: T0 + 10 * SECOND }).ok).toBe(true);
    expect(judge({ readings, now: T0 + 10 * SECOND + 2 * RELEASE_READING_MAX_AGE_MS }).ok).toBe(
      false,
    );
  });
});
