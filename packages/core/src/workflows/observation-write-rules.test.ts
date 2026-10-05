import { describe, expect, it } from 'vitest';
import {
  commitOffBranchRefusal,
  missingCitationRefusals,
  namesSymbol,
  revisionRefusal,
} from './observation-rules.js';
import type { WriteObservation } from './observation-schema.js';
import { rootGapsOf, unrootedRefusal } from './rooted.js';

const SHA = 'a'.repeat(40);

function write(steps: { id: string; file: string; symbol: string }[]): WriteObservation {
  return {
    atSha: SHA,
    steps: steps.map((s) => ({
      id: s.id,
      matches: null,
      does: 'does it',
      after: [],
      evidence: { kind: 'repo', file: s.file, symbol: s.symbol },
    })),
  };
}

const rooted = (approvedRevision: number | null, requirements: string[]) => {
  const missing = rootGapsOf(approvedRevision, requirements.length);
  return { rooted: missing.length === 0, approvedRevision, requirements, missing };
};

describe('an observation is taken only of a rooted design (design-reconciliation rooted)', () => {
  it('refuses a design with no approved revision, naming the approver act', () => {
    const r = unrootedRefusal('pilot', rooted(null, ['REQ-1']));
    expect(r?.code).toBe('WORKFLOW_OBSERVATION_UNROOTED');
    expect(r?.detail).toMatch(/no approved revision/);
  });

  it('refuses a design no requirement links, naming the BA act', () => {
    const r = unrootedRefusal('pilot', rooted(2, []));
    expect(r?.code).toBe('WORKFLOW_OBSERVATION_UNROOTED');
    expect(r?.detail).toMatch(/no requirement links it/);
  });

  it('names both gaps when both are missing', () => {
    expect(rooted(null, []).missing).toEqual(['approved_revision', 'requirement']);
  });

  it('admits an approved design serving a requirement', () => {
    expect(unrootedRefusal('pilot', rooted(2, ['REQ-1']))).toBeNull();
  });
});

describe('an observation is read against the approved revision only (cited)', () => {
  it('refuses another revision, naming both', () => {
    const r = revisionRefusal('pilot', 3, 2);
    expect(r?.code).toBe('WORKFLOW_OBSERVATION_REVISION_NOT_APPROVED');
    expect(r?.detail).toMatch(/r3.*r2/);
  });

  it('admits the approved revision, or none named', () => {
    expect(revisionRefusal('pilot', 2, 2)).toBeNull();
    expect(revisionRefusal('pilot', undefined, 2)).toBeNull();
  });
});

describe('every cited file and symbol exists at the commit (cited)', () => {
  const texts = new Map<string, string | { missing: string }>([
    ['src/a.ts', 'export function writeThing() {}\nconst fooBar = 1;'],
    ['src/gone.ts', { missing: `src/gone.ts does not exist at ${SHA}` }],
  ]);

  it('refuses a file the commit does not hold, at the node evidence path', () => {
    const [r] = missingCitationRefusals(
      write([{ id: 'x', file: 'src/gone.ts', symbol: 'any' }]),
      texts,
    );
    expect(r?.code).toBe('WORKFLOW_OBSERVATION_CITATION_MISSING');
    expect(r?.path).toBe('/steps/0/evidence');
    expect(r?.detail).toMatch(/src\/gone\.ts does not exist at/);
  });

  it('refuses a symbol its file does not name, as a whole word', () => {
    const out = missingCitationRefusals(
      write([
        { id: 'x', file: 'src/a.ts', symbol: 'writeNothing' },
        { id: 'y', file: 'src/a.ts', symbol: 'foo' },
      ]),
      texts,
    );
    expect(out.map((r) => r.path)).toEqual(['/steps/0/evidence', '/steps/1/evidence']);
  });

  it('admits a symbol the file names, a dotted one by every part', () => {
    expect(
      missingCitationRefusals(write([{ id: 'x', file: 'src/a.ts', symbol: 'writeThing' }]), texts),
    ).toEqual([]);
    expect(namesSymbol('class A { b() {} }', 'A.b')).toBe(true);
    expect(namesSymbol('class A {}', 'A.b')).toBe(false);
  });

  it('names the landing branch when the commit is off it', () => {
    const r = commitOffBranchRefusal(SHA, 'dev');
    expect(r.code).toBe('WORKFLOW_OBSERVATION_COMMIT_OFF_BRANCH');
    expect(r.detail).toMatch(/not on dev/);
  });
});
