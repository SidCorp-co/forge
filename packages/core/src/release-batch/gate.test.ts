// The gate answer is read by two very different callers: the batch service, where `null` only
// hides an action, and the close rewrite, where a non-null answer BLOCKS an agent from ever
// closing an issue. Since ISS-12 the only thing it reads is the project document.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOC_PROJECT,
  PROD_BINDING,
  production,
  projectDoc,
} from '../project-config/release-path.fixture.js';
import type { ProjectDocument } from '../project-config/schema.js';

const selectLimit = vi.fn(async () => [] as unknown[]);
const readDocument = vi.fn(
  async (): Promise<{ revision: number; document: ProjectDocument } | null> => null,
);
const findBinding = vi.fn(async (_id: string) => null as unknown);

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
  },
}));

vi.mock('../project-config/service.js', () => ({
  readProjectDocument: () => readDocument(),
}));

vi.mock('../integrations/store.js', () => ({
  findBindingWithConnectionById: (id: string) => findBinding(id),
}));

const { ReleaseTargetUndeclaredError, resolveReleaseDeclaration, resolveReleaseGate } =
  await import('./gate.js');

const held = (document: ProjectDocument) => ({ revision: 4, document });
const activeBinding = (over: { projectId?: string; active?: boolean } = {}) => ({
  binding: {
    id: PROD_BINDING,
    projectId: over.projectId ?? DOC_PROJECT,
    provider: 'coolify',
    role: 'deploy',
    active: over.active ?? true,
    config: {},
  },
  connection: { active: true },
});

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([{ id: DOC_PROJECT }]);
  readDocument.mockResolvedValue(null);
  findBinding.mockResolvedValue(activeBinding());
});

describe('resolveReleaseGate', () => {
  it('gives the gate to a project whose production deploys through an active binding', async () => {
    readDocument.mockResolvedValue(held(projectDoc({ environments: { beta: production() } })));
    await expect(resolveReleaseGate(DOC_PROJECT)).resolves.toBe('awaiting_release');
    expect(findBinding).toHaveBeenCalledWith(PROD_BINDING);
  });

  it('answers null for a document with no production environment: Forge ships nothing', async () => {
    readDocument.mockResolvedValue(
      held(
        projectDoc({
          environments: {
            dev: { tier: 'dev', deployment: { binding: PROD_BINDING, trigger: 'on-land' } },
          },
        }),
      ),
    );
    await expect(resolveReleaseGate(DOC_PROJECT)).resolves.toBeNull();
    expect(findBinding).not.toHaveBeenCalled();
  });

  it('is null for a project that does not exist, never a gate', async () => {
    selectLimit.mockResolvedValue([]);
    await expect(resolveReleaseGate(DOC_PROJECT)).resolves.toBeNull();
    expect(readDocument).not.toHaveBeenCalled();
  });
});

describe('a production environment with nowhere to land a release', () => {
  it('throws RELEASE_TARGET_UNDECLARED where the project has declared no document at all', async () => {
    await expect(resolveReleaseGate(DOC_PROJECT)).rejects.toThrow(ReleaseTargetUndeclaredError);
    await expect(resolveReleaseGate(DOC_PROJECT)).rejects.toThrow(
      /RELEASE_TARGET_UNDECLARED: .*declared no project document.*PUT \/api\/projects\/.*\/config/,
    );
  });

  it('throws where production is deployed outside Forge', async () => {
    readDocument.mockResolvedValue(
      held(projectDoc({ environments: { live: production({ binding: null }) } })),
    );
    await expect(resolveReleaseGate(DOC_PROJECT)).rejects.toThrow(
      /production environment `live` is deployed outside Forge/,
    );
  });

  it('throws where the production binding is inactive', async () => {
    readDocument.mockResolvedValue(held(projectDoc({ environments: { beta: production() } })));
    findBinding.mockResolvedValue(activeBinding({ active: false }));
    await expect(resolveReleaseGate(DOC_PROJECT)).rejects.toThrow(
      new RegExp(`binding ${PROD_BINDING}, which is not an active binding of this project`),
    );
  });

  it("throws where the production binding is another project's", async () => {
    readDocument.mockResolvedValue(held(projectDoc({ environments: { beta: production() } })));
    findBinding.mockResolvedValue(
      activeBinding({ projectId: '44444444-4444-4444-8444-444444444444' }),
    );
    await expect(resolveReleaseGate(DOC_PROJECT)).rejects.toThrow(/not an active binding/);
  });

  it('throws where no promotion carries a landed change to the branch production deploys from', async () => {
    readDocument.mockResolvedValue(
      held(
        projectDoc({
          defaultBranch: 'dev',
          branches: ['main'],
          environments: { beta: production({ deploysFrom: 'main' }) },
        }),
      ),
    );
    await expect(resolveReleaseGate(DOC_PROJECT)).rejects.toThrow(
      /deploys from `main`, and no promotion reaches `main` from `dev`/,
    );
  });
});

describe('resolveReleaseDeclaration', () => {
  it('carries EVERY promotion a landed change crosses, in order', async () => {
    const promotions = [
      { from: 'dev', to: 'stg', via: 'merge' as const },
      { from: 'stg', to: 'live', via: 'cherry-pick' as const },
    ];
    readDocument.mockResolvedValue(
      held(
        projectDoc({
          defaultBranch: 'dev',
          promotions,
          environments: { prod: production({ deploysFrom: 'live' }) },
        }),
      ),
    );
    const decl = await resolveReleaseDeclaration(DOC_PROJECT);
    expect(decl?.kind).toBe('gated');
    if (decl?.kind !== 'gated') return;
    expect(decl.path.crossings).toEqual(promotions);
    expect(decl.deploysFrom).toBe('live');
    expect(decl.defaultBranch).toBe('dev');
    expect(decl.production.name).toBe('prod');
  });

  it('crosses nothing where production deploys from the branch work lands on', async () => {
    readDocument.mockResolvedValue(held(projectDoc({ environments: { beta: production() } })));
    const decl = await resolveReleaseDeclaration(DOC_PROJECT);
    expect(decl?.kind === 'gated' && decl.deploysFrom).toBeNull();
    expect(decl?.kind === 'gated' && decl.path.crossings).toEqual([]);
  });

  it('answers no-release with the default branch, without reading a binding', async () => {
    readDocument.mockResolvedValue(held(projectDoc({ defaultBranch: 'trunk' })));
    await expect(resolveReleaseDeclaration(DOC_PROJECT)).resolves.toEqual({
      kind: 'no-release',
      defaultBranch: 'trunk',
    });
    expect(findBinding).not.toHaveBeenCalled();
  });
});
