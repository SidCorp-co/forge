import { describe, expect, it, vi } from 'vitest';

const providers: Array<{ id: string; slug: string; name: string }> = [];
vi.mock('../store.js', () => ({ projectsWhere: async () => providers }));
vi.mock('../../requirements/service.js', () => ({ lockRequirements: async () => undefined }));
vi.mock('../../requirements/revision-write.js', () => ({
  createRequirementIn: async () => ({ id: 'req', refusals: null }),
}));

const { landChangeRequestIn } = await import('./land.js');
const { Refused } = await import('../channel-act.js');

const HOP = '11111111-1111-4111-8111-111111111111';
const AUTOFLOW = '22222222-2222-4222-8222-222222222222';
const inserted: unknown[] = [];
const tx = { insert: () => ({ values: async (v: unknown) => inserted.push(v) }) } as never;

const cr = (contract: string) =>
  ({
    type: 'change-request',
    state: 'published',
    from: HOP,
    number: 'HOP-CR-3',
    body: { contract, need: 'rollbackTo', rationale: 'r', impactIfDeclined: 'i', urgency: 'high' },
  }) as never;

const by = { userId: 'u', agency: 'human' as const };

async function codeOf(doc: never): Promise<string | null> {
  try {
    await landChangeRequestIn(tx, doc, { documentId: 'd', by });
    return null;
  } catch (err) {
    if (err instanceof Refused) return err.refusals.map((r) => r.code).join(',');
    throw err;
  }
}

describe('a published change request lands as the provider’s draft requirement (E2)', () => {
  it('refuses a contract that names no project, or the sender’s own, by name', async () => {
    providers.length = 0;
    expect(await codeOf(cr('nobody/book-follow-up'))).toBe('CONTRACT_REQUEST_PROVIDER_UNKNOWN');
    providers.push({ id: HOP, slug: 'hop', name: 'hop' });
    expect(await codeOf(cr('hop/book-follow-up'))).toBe('CONTRACT_REQUEST_PROVIDER_UNKNOWN');
  });

  it('pairs the document with the requirement it landed as, in the provider', async () => {
    providers.length = 0;
    providers.push({ id: AUTOFLOW, slug: 'autoflow', name: 'autoflow' });
    inserted.length = 0;
    expect(await codeOf(cr('autoflow/book-follow-up'))).toBeNull();
    expect(inserted).toEqual([
      expect.objectContaining({
        projectId: HOP,
        providerProjectId: AUTOFLOW,
        contractSlug: 'book-follow-up',
        channelDocumentId: 'd',
        requirementId: 'req',
        requestedBy: 'u',
        requestedAgency: 'human',
      }),
    ]);
  });
});
