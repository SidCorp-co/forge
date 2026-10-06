/**
 * ISS-1327 — the one answer to "what counts as evidence that this landed", as pure functions. The
 * doors that call it are held at their own runtimes: `merged-at.test.ts`, `entry-criteria.test.ts`,
 * `merge-mark-route.test.ts`, and against Postgres in `tests/integration/landing-evidence-e2e.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  LANDINGS_ACCEPTED,
  type Lane,
  landingMarkRefusal,
  landingRoute,
  landingShapeInputSchema,
  landingShapeOf,
  landingShortfall,
  laneOf,
  markTargetRequired,
  mergedLandingSchema,
  standingMarkRefusal,
  UnknownProjectKindError,
} from './landing-evidence.js';

const AT = new Date('2026-09-29T14:44:34Z');
const UNMARKED = { mergedAt: null, mergedCommitSha: null, mergedLanding: null };
const ASSERTED = { ...UNMARKED, mergedAt: AT };
const OBSERVED = { ...ASSERTED, mergedCommitSha: '07f73960b2ce7ea1dfa1f050ec64d9bd0c80fe67' };
const LANDED = { ...ASSERTED, mergedLanding: 'https://mowmentbrand.com/products/tee' };
const GIT: Lane = { shape: 'git', declared: false };
const OUTSIDE: Lane = { shape: 'outside_git', declared: false };
const DECLARED_OUTSIDE: Lane = { shape: 'outside_git', declared: true };
const LANE = { git: GIT, outside_git: OUTSIDE } as const;

describe('the shape is read off the project kind, and nothing else', () => {
  it('reads website as landing outside git and standard as landing in git', () => {
    expect(landingShapeOf('website')).toBe('outside_git');
    expect(landingShapeOf('standard')).toBe('git');
  });

  it('refuses a kind no route writes by name, rather than defaulting it to either shape', () => {
    expect(() => landingShapeOf('publish')).toThrow('project kind `publish` is not one of');
    expect(() => landingShapeOf('')).toThrow('`standard`, `website`');
  });

  it('names the project and the route that sets its kind, as an error a door can refuse by', () => {
    const thrown = (() => {
      try {
        landingShapeOf('kiosk', 'p-1');
      } catch (err) {
        return err;
      }
    })();
    expect(thrown).toBeInstanceOf(UnknownProjectKindError);
    expect(thrown).toMatchObject({ kind: 'kiosk', projectId: 'p-1' });
    expect((thrown as Error).message).toContain("project p-1's kind `kiosk` is not one of");
    expect((thrown as Error).message).toContain('`kind` on `PATCH /api/projects/:id`');
  });
});

describe("an issue's own declaration answers before its project's kind (ISS-1384)", () => {
  it('reads the declaration where the issue holds one, whatever the kind', () => {
    expect(laneOf({ declared: 'outside_git', kind: 'standard' })).toEqual(DECLARED_OUTSIDE);
    expect(laneOf({ declared: 'git', kind: 'website' })).toEqual({ shape: 'git', declared: true });
  });

  it("reads the project's kind where the issue declares nothing", () => {
    expect(laneOf({ declared: null, kind: 'standard' })).toEqual(GIT);
    expect(laneOf({ declared: undefined, kind: 'website' })).toEqual(OUTSIDE);
  });

  it('refuses a declared value outside the two shapes by name rather than guessing a lane', () => {
    expect(() => laneOf({ declared: 'svn', kind: 'standard' })).toThrow(
      'issue declares landing shape `svn`',
    );
  });

  it('takes the two shapes and null at the write, and refuses anything else naming the field', () => {
    expect(landingShapeInputSchema.parse('outside_git')).toBe('outside_git');
    expect(landingShapeInputSchema.parse(null)).toBeNull();
    const refused = landingShapeInputSchema.safeParse('website');
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toContain(
      '`landingShape` must be `git` or `outside_git`',
    );
    expect(refused.error?.issues[0]?.message).toContain('got "website"');
  });

  it("names the issue's declaration in every sentence a declared lane prints, never the kind", () => {
    const sentences = [
      landingRoute(DECLARED_OUTSIDE),
      landingShortfall(ASSERTED, DECLARED_OUTSIDE) as string,
      landingMarkRefusal({ lane: DECLARED_OUTSIDE, landing: null, observed: false })?.detail,
      landingMarkRefusal({
        lane: { shape: 'git', declared: true },
        landing: 'https://x',
        observed: false,
      })?.detail,
    ];
    for (const sentence of sentences) {
      expect(sentence).toMatch(/declared/);
      expect(sentence).not.toContain('kind `website`');
      expect(sentence).not.toContain('kind is not `website`');
    }
  });

  it('tells a git lane sending a landing how to declare the issue outside git', () => {
    expect(
      landingMarkRefusal({ lane: GIT, landing: 'https://x', observed: false })?.detail,
    ).toContain('`landingShape: outside_git`');
  });
});

describe('which marks count as landed, per shape', () => {
  it('keeps the git shape exactly as it was: a claim or an observed merge', () => {
    expect([...LANDINGS_ACCEPTED.git].sort()).toEqual(['asserted', 'observed']);
    expect(landingShortfall(ASSERTED, GIT)).toBeNull();
    expect(landingShortfall(OBSERVED, GIT)).toBeNull();
    expect(landingShortfall(UNMARKED, GIT)).not.toBeNull();
  });

  it('asks the outside-git shape for a named landing or an observed merge', () => {
    expect([...LANDINGS_ACCEPTED.outside_git].sort()).toEqual(['landed', 'observed']);
    expect(landingShortfall(LANDED, OUTSIDE)).toBeNull();
    expect(landingShortfall(OBSERVED, OUTSIDE)).toBeNull();
  });

  it('refuses a bare timestamp on the outside-git shape: it names nothing that landed', () => {
    const short = landingShortfall(ASSERTED, OUTSIDE) as string;
    expect(short).toContain('names no landing');
    expect(short).not.toMatch(/merged pull request|merged_commit_sha|CLAIM Forge did not observe/);
    expect(short).toContain('accepts `landed` or `observed`');
  });

  it('refuses no mark on either shape, naming the kinds that would have passed', () => {
    for (const shape of ['git', 'outside_git'] as const) {
      const short = landingShortfall(UNMARKED, LANE[shape]) as string;
      for (const kind of LANDINGS_ACCEPTED[shape]) expect(short).toContain(`\`${kind}\``);
    }
  });
});

describe('the route a refusal names is the one the shape has', () => {
  it('names mark_merged with a commit on the git shape, and a declaration for a change that lands no file', () => {
    const route = landingRoute(GIT);
    expect(route).toContain('`mark_merged`, naming the commit it landed at in `data.commit`');
    expect(route).toContain('`landingShape: outside_git`');
    // `landing` on this lane is refused LANDING_NOT_THIS_SHAPE, so it is never the route offered.
    expect(route).not.toContain('naming where it landed');
  });

  it('ends on the act the refused caller takes next', () => {
    expect(landingRoute(GIT)).toContain('then close.');
    expect(landingRoute(OUTSIDE, 'asserted', 'enter this status')).toContain(
      'then enter this status.',
    );
  });

  it('names data.landing on the outside-git shape, and asks for no commit', () => {
    const route = landingRoute(OUTSIDE);
    expect(route).toContain('`data.landing`');
    expect(route).toContain('`landing` on `POST /api/issues/:id/merge`');
    expect(route).toContain('a commit is not asked for');
    expect(route).not.toContain('`unmark`');
  });

  it('names unmark first where a bare mark already holds the row, since the first stamp wins', () => {
    expect(landingRoute(OUTSIDE, 'asserted')).toMatch(/^This issue already carries .*`unmark`/);
    expect(landingRoute(GIT, 'asserted')).not.toContain('`unmark`');
  });
});

describe('what the mark writer refuses', () => {
  it('refuses a landing on a project that lands in git', () => {
    expect(landingMarkRefusal({ lane: GIT, landing: 'https://x', observed: false })?.code).toBe(
      'LANDING_NOT_THIS_SHAPE',
    );
  });

  it('refuses a mark with no landing on the outside-git shape unless Forge observed a merge', () => {
    expect(landingMarkRefusal({ lane: OUTSIDE, landing: null, observed: false })?.code).toBe(
      'LANDING_REQUIRED',
    );
    expect(landingMarkRefusal({ lane: OUTSIDE, landing: null, observed: true })).toBeNull();
  });

  it('lets the two well-formed marks through', () => {
    expect(landingMarkRefusal({ lane: GIT, landing: null, observed: false })).toBeNull();
    expect(
      landingMarkRefusal({ lane: OUTSIDE, landing: 'cms://entry/9', observed: false }),
    ).toBeNull();
  });
});

describe('the landing field', () => {
  it('refuses blank text and text past 2000 characters, and trims what it keeps', () => {
    expect(mergedLandingSchema.safeParse('   ').success).toBe(false);
    expect(mergedLandingSchema.safeParse('x'.repeat(2001)).success).toBe(false);
    expect(mergedLandingSchema.safeParse('x'.repeat(2000)).success).toBe(true);
    expect(mergedLandingSchema.parse('  https://shop.example/p  ')).toBe('https://shop.example/p');
  });
});

describe('a landing sent over a mark that stands', () => {
  const TYPO = 'https://mowmentbrand.com/prodcts/tee';

  it('refuses a landing that differs from the one standing, naming both and the route', () => {
    const refusal = standingMarkRefusal({ sent: TYPO, wrote: false, held: LANDED });
    expect(refusal?.code).toBe('MARK_ALREADY_STANDS');
    expect(refusal?.detail).toContain(LANDED.mergedLanding);
    expect(refusal?.detail).toContain(`${TYPO} was not recorded`);
    expect(refusal?.detail).toContain('`unmark`');
    expect(refusal?.details).toMatchObject({
      heldLanding: LANDED.mergedLanding,
      heldKind: 'landed',
    });
  });

  it('refuses a landing sent over a mark that names none', () => {
    const refusal = standingMarkRefusal({ sent: TYPO, wrote: false, held: ASSERTED });
    expect(refusal?.detail).toContain('a mark (asserted) that names no landing');
    expect(refusal?.details).toMatchObject({ heldLanding: null, heldKind: 'asserted' });
  });

  it('lets the exact landing re-sent, a stamp that wrote, and a mark with no landing through', () => {
    expect(
      standingMarkRefusal({ sent: LANDED.mergedLanding, wrote: false, held: LANDED }),
    ).toBeNull();
    expect(standingMarkRefusal({ sent: TYPO, wrote: true, held: LANDED })).toBeNull();
    expect(standingMarkRefusal({ sent: null, wrote: false, held: ASSERTED })).toBeNull();
  });

  it('owes a target only on the shape that moves branches', () => {
    expect(markTargetRequired('git')).toBe(true);
    expect(markTargetRequired('outside_git')).toBe(false);
  });
});
