import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRefusal } from '../lib/refusal.js';

const designArtifacts = [{ surface: 'design', ref: 'checkout-flow@rev2', change: 'changed' }];
const stampedAt = new Date('2026-10-01T00:00:00Z');
const committedAt = new Date('2026-10-02T00:00:00Z');
const SHA = 'abcdef1234567';
const designOnly = {
  id: 'i1',
  projectId: 'p1',
  status: 'in_progress',
  mergedAt: stampedAt,
  mergedCommitSha: null,
  mergedLanding: null,
  mergedArtifacts: designArtifacts,
  mergedPaths: null,
};
let prior: Record<string, unknown> = designOnly;

// Each awaited query on the transaction takes the next answer, in the order the mark makes them.
const answers: unknown[][] = [];
const chain: unknown = new Proxy(() => {}, {
  get: (_t, p) =>
    p === 'then' ? (res: (v: unknown) => void) => res(answers.shift() ?? []) : () => chain,
});
vi.mock('../db/client.js', () => ({
  db: { transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(chain) },
}));
vi.mock('../outbox/index.js', () => ({ emitEvent: async () => {}, emitEvents: async () => {} }));
vi.mock('./read-service.js', () => ({ findIssueById: async () => prior }));
vi.mock('./ports.js', () => ({
  contractDrift: async () => null,
  postIssueNotice: async (args: { body: string }) => ({
    id: 'c1',
    body: args.body,
    parentId: null,
  }),
}));
vi.mock('./landing-evidence.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLandingShape: async () => 'git',
}));
const readCommitLanding = vi.fn();
vi.mock('./commit-landing.js', () => ({ readCommitLanding }));
vi.mock('./work-evidence.js', () => ({
  findMissingWorkEvidence: async () => null,
  collectWorkEvidence: async () => ({ handoffCommitSha: null }),
}));

const { applyMergeMarker } = await import('./merge-marker.js');

const actorOf = (agency: 'human' | 'agent') => ({
  agency,
  commentAuthorId: 'u1',
  hookActor: { type: 'user', id: 'u1', agency } as never,
});

function mark(agency: 'human' | 'agent', extra: Record<string, unknown> = {}) {
  return applyMergeMarker({
    issue: { id: 'i1', projectId: 'p1', mergedAt: stampedAt },
    op: 'mark',
    target: 'dev',
    commit: SHA,
    actor: actorOf(agency),
    ...extra,
  });
}

beforeEach(() => {
  prior = designOnly;
  answers.length = 0;
  readCommitLanding.mockReset();
});

describe('a code mark over a design approval stamp (H2)', () => {
  for (const agency of ['human', 'agent'] as const) {
    it(`a ${agency} mark naming a commit the repository attributes records it as observed`, async () => {
      readCommitLanding.mockResolvedValue({
        ok: true,
        sha: SHA,
        committedAt,
        branch: 'dev',
        repository: 'acme/shop',
      });
      const observedRow = {
        mergedAt: committedAt,
        mergedCommitSha: SHA,
        mergedLanding: null,
        mergedArtifacts: designArtifacts,
      };
      answers.push([], [prior], [observedRow], []);
      const out = await mark(agency);
      expect(readCommitLanding).toHaveBeenCalledWith({ issueId: 'i1', commit: SHA });
      expect(out.action).toBe('merged');
      expect(out.mark).toBe('observed');
      expect(out.markDetail).toContain('read from acme/shop itself');
      expect(out.artifacts).toEqual(designArtifacts);
    });
  }

  it('refuses MARK_ALREADY_STANDS naming the design stamp and why, where the commit cannot be read', async () => {
    readCommitLanding.mockResolvedValue({
      ok: false,
      code: 'COMMIT_UNVERIFIED',
      detail: 'commit abcdef1234567 could not be checked',
    });
    const err = await mark('human').catch((e: unknown) => e);
    expect(isRefusal(err, 'MARK_ALREADY_STANDS')).toBe(true);
    const detail = (err as { refusals: { detail: string; path: string }[] }).refusals[0];
    expect(detail?.path).toBe('/commit');
    expect(detail?.detail).toContain('checkout-flow@rev2');
    expect(detail?.detail).toContain('could not be checked');
  });

  it('keeps the box path: paths read for the commit are recorded where no host can read it', async () => {
    readCommitLanding.mockResolvedValue({
      ok: false,
      code: 'COMMIT_UNVERIFIED',
      detail: 'no host',
    });
    const held = {
      mergedAt: stampedAt,
      mergedCommitSha: null,
      mergedLanding: null,
      mergedArtifacts: designArtifacts,
    };
    answers.push([], [prior], [], [held], [{ projectId: 'p1' }], []);
    const out = await mark('agent', {
      changedPaths: { commit: SHA, changes: [{ path: 'src/a.ts', change: 'changed' }] },
    });
    expect(out.action).toBe('already_merged');
  });

  it('reads no commit where the stamp is not design-only', async () => {
    prior = { ...designOnly, mergedArtifacts: null };
    const held = { mergedAt: stampedAt, mergedCommitSha: null, mergedLanding: null };
    answers.push([], [prior], [], [{ ...held, mergedArtifacts: null }], []);
    const out = await mark('human');
    expect(readCommitLanding).not.toHaveBeenCalled();
    expect(out.action).toBe('already_merged');
  });
});
