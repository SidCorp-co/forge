import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '../../project-config/schema.js';
import { corroborationOf, environmentFault, readSourceDraft } from './storefront-draft.js';

const identity = {
  kind: 'storefront_draft' as const,
  workflowId: 'wf-1',
  draftVersion: 'a'.repeat(64),
  environment: 'preview',
};

const doc = (source: ProjectDocument['source']) =>
  ({
    source,
    environments: {
      preview: { tier: 'preview', deployment: { mode: 'external' } },
      production: { tier: 'production', deployment: { mode: 'external' } },
    },
  }) as unknown as ProjectDocument;

const storefront = doc({
  type: 'storefront',
  storefront: { provider: 'autoflow', binding: 'c3139761-c5a1-442d-8971-80d4dba53ef2' },
});

describe('environmentFault (ISS-91)', () => {
  it('admits a declared environment off production', () => {
    expect(environmentFault(1, storefront, 'preview')).toBeNull();
  });

  it('refuses an undeclared environment by name, listing the declared ones', () => {
    const fault = environmentFault(2, storefront, 'staging');
    expect(fault?.code).toBe('VERDICT_ENVIRONMENT_UNKNOWN');
    expect(fault?.detail).toContain('`preview`, `production`');
  });

  it('refuses production: a draft is unpublished, and a published version is judged at release', () => {
    expect(environmentFault(3, storefront, 'production')?.detail).toContain('tier is production');
  });

  it('refuses where the project declares no document', () => {
    expect(environmentFault(4, null, 'preview')?.code).toBe('VERDICT_ENVIRONMENT_UNKNOWN');
  });
});

describe('corroborationOf (ISS-91)', () => {
  it('corroborates the draft version the source holds now', () => {
    expect(
      corroborationOf(identity, { kind: 'read', draftVersion: 'a'.repeat(64), workflowCode: 'x' }),
    ).toEqual({ corroboration: 'corroborated', note: null });
  });

  it('stores a moved draft as uncorroborated, naming the version held now', () => {
    const found = corroborationOf(identity, {
      kind: 'read',
      draftVersion: 'b'.repeat(64),
      workflowCode: 'discharge',
    });
    expect(found.corroboration).toBe('uncorroborated');
    expect(found.note).toContain(`draft version \`${'b'.repeat(64)}\` now`);
  });

  it('stores an unreadable source as uncorroborated, saying why', () => {
    expect(corroborationOf(identity, { kind: 'unreadable', detail: 'http_502' })).toEqual({
      corroboration: 'uncorroborated',
      note: 'http_502',
    });
  });
});

describe('readSourceDraft (ISS-91)', () => {
  it('reads nothing for a git project, and says the source is not a storefront', async () => {
    const reading = await readSourceDraft(
      doc({
        type: 'git',
        git: { repository: 'github.com/a/b', defaultBranch: 'main', branches: ['main'] },
      }),
      'wf-1',
    );
    expect(reading).toEqual({
      kind: 'unreadable',
      detail:
        "this project's source is `git`, not a storefront: no provider holds a draft of its work for core to read",
    });
  });

  it('reads nothing where no project document is declared', async () => {
    expect((await readSourceDraft(null, 'wf-1')).kind).toBe('unreadable');
  });
});
