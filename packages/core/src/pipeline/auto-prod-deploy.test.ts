import { beforeEach, describe, expect, it, vi } from 'vitest';

const projectRow = vi.fn(async () => [] as unknown[]);
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => projectRow() }) }) }) },
}));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn() } }));

const { projectAutoProdDeploy, readAutoProdDeploy } = await import('./auto-prod-deploy.js');

const declaring = (value: unknown) => [
  { agentConfig: { pipelineConfig: { autoProdDeploy: value } } },
];

beforeEach(() => {
  projectRow.mockReset();
});

describe('autoProdDeploy', () => {
  it('reads true only where the project declares it true', async () => {
    projectRow.mockResolvedValue(declaring(true));
    expect(await readAutoProdDeploy('p')).toBe(true);
    projectRow.mockResolvedValue(declaring('true'));
    expect(await readAutoProdDeploy('p')).toBe(false);
    projectRow.mockResolvedValue([{ agentConfig: null }]);
    expect(await readAutoProdDeploy('p')).toBe(false);
    projectRow.mockResolvedValue([]);
    expect(await readAutoProdDeploy('p')).toBe(false);
  });

  it('refuses by name where the read fails, so a caller can say it could not read', async () => {
    projectRow.mockRejectedValue(new Error('projects table unreadable'));
    await expect(readAutoProdDeploy('p')).rejects.toThrow('projects table unreadable');
  });

  it('keeps the gate on for the callers that never asked to be told', async () => {
    projectRow.mockRejectedValue(new Error('projects table unreadable'));
    expect(await projectAutoProdDeploy('p')).toBe(false);
  });
});
