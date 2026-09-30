import { beforeEach, describe, expect, it, vi } from 'vitest';

const readProjectDocument = vi.fn(async (_projectId: string): Promise<unknown> => null);
vi.mock('../project-config/service.js', () => ({
  readProjectDocument: (projectId: string) => readProjectDocument(projectId),
}));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn() } }));

const { projectAutoProdDeploy } = await import('./auto-prod-deploy.js');

const BINDING = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const held = (environments: Record<string, unknown>) => ({
  revision: 1,
  document: { environments },
});
const env = (tier: string, trigger: string) => ({
  tier,
  deployment: { binding: BINDING, trigger },
});

beforeEach(() => {
  readProjectDocument.mockReset();
});

describe('projectAutoProdDeploy — read from the project document, never the old config', () => {
  it('is on when the production environment deploys on land', async () => {
    readProjectDocument.mockResolvedValue(
      held({ dev: env('dev', 'on-request'), beta: env('production', 'on-land') }),
    );
    expect(await projectAutoProdDeploy('p1')).toBe(true);
  });

  it.each(['on-request', 'provider'])('is off when production deploys %s', async (trigger) => {
    readProjectDocument.mockResolvedValue(held({ beta: env('production', trigger) }));
    expect(await projectAutoProdDeploy('p1')).toBe(false);
  });

  it('is off when only a non-production environment deploys on land', async () => {
    readProjectDocument.mockResolvedValue(held({ dev: env('dev', 'on-land') }));
    expect(await projectAutoProdDeploy('p1')).toBe(false);
  });

  it('is off for a project with no document', async () => {
    expect(await projectAutoProdDeploy('p1')).toBe(false);
  });

  it('keeps the gate on when the document cannot be read', async () => {
    readProjectDocument.mockImplementation(async () => {
      throw new Error('the stored document no longer parses');
    });
    expect(await projectAutoProdDeploy('p1')).toBe(false);
  });
});
