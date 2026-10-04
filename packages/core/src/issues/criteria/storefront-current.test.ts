import { describe, expect, it, vi } from 'vitest';
import type { StorefrontDraftReading } from '../../integrations/types.js';
import type { CriterionWithVerdict, LatestVerdict } from './store.js';

vi.mock('../../project-config/service.js', () => ({
  readProjectDocument: async () => ({ document: { source: { type: 'storefront' } } }),
}));

const { currentDraftReading, withCurrentDrafts } = await import('./storefront-draft.js');

const JUDGED = 'a'.repeat(64);
const MOVED = 'b'.repeat(64);

const row = (n: number, over: Partial<LatestVerdict>): CriterionWithVerdict => ({
  id: `c${n}`,
  n,
  statement: 's',
  position: n,
  requirementCriterionId: null,
  latest: {
    id: `v${n}`,
    verdict: 'pass',
    reason: null,
    identityKind: 'storefront_draft',
    commitSha: null,
    runtimeRef: null,
    designWorkflowId: null,
    designFlow: null,
    designRevision: null,
    contractRef: null,
    contractVersion: null,
    storefrontWorkflowId: '102',
    storefrontDraftVersion: JUDGED,
    storefrontEnvironment: 'preview',
    corroboration: 'corroborated',
    corroborationNote: null,
    evidence: [],
    authorAgency: 'agent',
    backfilled: false,
    createdAt: '2026-10-04T00:00:00.000Z',
    ...over,
  },
});

const read = (draftVersion: string): StorefrontDraftReading => ({
  kind: 'read',
  draftVersion,
  workflowCode: 'discharge',
});

describe('currentDraftReading (FB-56)', () => {
  it('corroborates a verdict while the storefront holds the draft it judged', () => {
    expect(currentDraftReading({ workflowId: '102', draftVersion: JUDGED }, read(JUDGED))).toEqual({
      corroboration: 'corroborated',
      note: null,
    });
  });

  it('reads a moved draft as superseded, naming the draft held now', () => {
    const found = currentDraftReading({ workflowId: '102', draftVersion: JUDGED }, read(MOVED));
    expect(found.corroboration).toBe('superseded');
    expect(found.note).toContain(`at draft version \`${MOVED}\` now, not \`${JUDGED}\``);
  });

  it('reads an unreadable source as uncorroborated, saying why, never as corroborated', () => {
    const found = currentDraftReading(
      { workflowId: '102', draftVersion: JUDGED },
      { kind: 'unreadable', detail: 'unauthorized: token expired' },
    );
    expect(found.corroboration).toBe('uncorroborated');
    expect(found.note).toContain('unauthorized: token expired');
  });

  it('reads a workflow the storefront no longer holds as uncorroborated', () => {
    expect(
      currentDraftReading(
        { workflowId: '102', draftVersion: JUDGED },
        { kind: 'missing', detail: 'no workflow 102' },
      ).corroboration,
    ).toBe('uncorroborated');
  });
});

describe('withCurrentDrafts (FB-56)', () => {
  it('replaces a stored corroborated with the reading of the draft held now, once per workflow', async () => {
    const readDraft = vi.fn(async (_doc: unknown, workflowId: string) =>
      read(workflowId === '102' ? MOVED : JUDGED),
    );
    const out = await withCurrentDrafts(
      'p',
      [row(1, {}), row(2, {}), row(3, { storefrontWorkflowId: '105' })],
      readDraft,
    );
    expect(readDraft).toHaveBeenCalledTimes(2);
    expect(out.map((c) => c.latest?.corroboration)).toEqual([
      'superseded',
      'superseded',
      'corroborated',
    ]);
    expect(out[0]?.latest?.corroborationNote).toContain(MOVED);
  });

  it('planted red: a stored uncorroborated verdict at the draft held now reads corroborated', async () => {
    const out = await withCurrentDrafts(
      'p',
      [row(1, { corroboration: 'uncorroborated', corroborationNote: 'http_502' })],
      async () => read(JUDGED),
    );
    expect(out[0]?.latest).toMatchObject({
      corroboration: 'corroborated',
      corroborationNote: null,
    });
  });

  it('leaves every other identity alone and reads nothing when no draft is judged', async () => {
    const readDraft = vi.fn(async () => read(MOVED));
    const commit = row(1, {
      identityKind: 'commit',
      commitSha: '3641ba21fec5096e2d1a91a40f2d9e50e9239068',
      storefrontWorkflowId: null,
      storefrontDraftVersion: null,
      storefrontEnvironment: null,
      corroboration: null,
    });
    const out = await withCurrentDrafts('p', [commit], readDraft);
    expect(readDraft).not.toHaveBeenCalled();
    expect(out).toEqual([commit]);
  });
});
