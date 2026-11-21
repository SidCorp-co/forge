import { describe, expect, it } from 'vitest';
import { blocker } from './blocker-kit.js';
import { NO_RELEASE_GATE_HOLD } from './hold.js';
import { gateViews } from './release-gates.js';
import { releaseOwesOf } from './release-owes.js';

const POLICY = (strict: boolean) => ({
  strict,
  gates: {
    agree: false,
    revisions: false,
    breakdown: false,
    admit: false,
    accept: false,
    designs: false,
    triage: true,
  },
  releaseApproval: false,
});

// PR #1055 review: catalog-api 0.1.0's banner read "Waiting on you: declare a production environment"
// while its gate, on the same page, read "No release step. This project ships on close; there is no
// release to cut." An issue at the release gate closes only through a release
// (`transition-guards.ts:releaseGuard`), so the gate's own words said what the kernel refuses. With
// no production environment that release is the recorded landing (`recorded-landing.ts`), and the
// gate names that act rather than one the project never asked for.

describe('a project with no production environment, said by its gate', () => {
  const [gate] = gateViews(
    [blocker('NO_RELEASE_GATE')],
    [],
    ['orchestrator'],
    releaseOwesOf(POLICY(false), []),
  );

  it('names what is missing, in the words the banner and the rail use', () => {
    expect(gate?.title).toBe('No production');
    expect(gate?.sentence).toBe("Landing on the working branch is this project's delivery.");
    expect(gate?.owner.act).toBe('record the landing');
  });

  it('never says closing an issue ships it: only a release closes one at the gate', () => {
    for (const said of [
      gate?.title,
      gate?.sentence,
      gate?.detail,
      NO_RELEASE_GATE_HOLD.reason,
      NO_RELEASE_GATE_HOLD.waitingFor,
    ]) {
      expect(said).not.toMatch(
        /ships on close|closing an issue is what ships|or close the issue|no release step/i,
      );
    }
  });
});

// ISS-1388 (FB-798, FB-800): a sidpeak master with a 0.30.0 draft holding only ISS-21, shipped in
// v0.28.0, searched the release for a way to clear it and filed the door that exists as missing.
describe('a draft whose issues an earlier release already shipped, said by its gate', () => {
  const [gate] = gateViews(
    [
      blocker('RELEASE_SHIPPED_IN_OWED', {
        issueIds: ['i21'],
        displayIds: ['ISS-21'],
        versions: ['0.28.0'],
      }),
    ],
    [],
    ['orchestrator'],
    releaseOwesOf(POLICY(false), []),
  );

  it('names shipped-in-records and the version it reads, on its sentence and in the act the standing carries', () => {
    expect(gate?.sentence).toContain('shipped-in-records');
    expect(gate?.sentence).toContain('0.28.0');
    expect(gate?.owner.act).toContain('shipped-in-records');
    expect(gate?.owner.act).toContain('0.28.0');
  });
});

describe('the shipped-in-records card says when to use the door (ISS-1388)', () => {
  it('names an issue an earlier release shipped, and a draft holding only such issues', async () => {
    const { RELEASE_REST_CARDS } = await import('./cards.js');
    const card = RELEASE_REST_CARDS['POST /api/projects/:projectId/shipped-in-records'];
    const when = card.situations.map((s) => s.when).join(' ');
    expect(when).toContain('shipped by an earlier release');
    expect(when).toContain('a draft holds only such issues');
  });
});
