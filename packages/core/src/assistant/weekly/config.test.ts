/**
 * ISS-1056 — absent is OFF: only `enabled: true` with the three required fields opts a project
 * in, and the list carries exactly those projects.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));

const { listOptedInProjects, readAssistantWeekly, resolveAssistantWeekly } = await import(
  './config.js'
);

const on = {
  enabled: true,
  pinnedIssue: 'ISS-9',
  judgeProviderId: 'litellm',
  judgeModel: 'judge-x',
};

describe('readAssistantWeekly', () => {
  it('reads an enabled config and carries the optional source', () => {
    expect(readAssistantWeekly({ pipelineConfig: { assistantWeekly: on } })).toEqual({
      pinnedIssue: 'ISS-9',
      judgeProviderId: 'litellm',
      judgeModel: 'judge-x',
    });
    expect(
      readAssistantWeekly({ pipelineConfig: { assistantWeekly: { ...on, source: 'web' } } }),
    ).toMatchObject({
      source: 'web',
    });
  });

  it('absent, null, disabled, or missing a required field is OFF', () => {
    expect(readAssistantWeekly(null)).toBeNull();
    expect(readAssistantWeekly({})).toBeNull();
    expect(readAssistantWeekly({ pipelineConfig: {} })).toBeNull();
    expect(
      readAssistantWeekly({ pipelineConfig: { assistantWeekly: { ...on, enabled: false } } }),
    ).toBeNull();
    expect(
      readAssistantWeekly({ pipelineConfig: { assistantWeekly: { ...on, enabled: 'true' } } }),
    ).toBeNull();
    expect(
      readAssistantWeekly({ pipelineConfig: { assistantWeekly: { ...on, judgeModel: '' } } }),
    ).toBeNull();
  });
});

const selectOf = (rows: unknown[]) => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  return { select: () => chain } as never;
};

describe('resolveAssistantWeekly and listOptedInProjects', () => {
  it('resolves one project from its agentConfig row', async () => {
    const dbi = selectOf([{ agentConfig: { pipelineConfig: { assistantWeekly: on } } }]);
    expect(await resolveAssistantWeekly('p1', dbi)).toMatchObject({ pinnedIssue: 'ISS-9' });
    expect(await resolveAssistantWeekly('p1', selectOf([]))).toBeNull();
  });

  it('lists only the projects whose config is on and that have a creator to post as', async () => {
    const dbi = selectOf([
      {
        projectId: 'a',
        slug: 'a',
        createdBy: 'u1',
        agentConfig: { pipelineConfig: { assistantWeekly: on } },
      },
      { projectId: 'b', slug: 'b', createdBy: 'u1', agentConfig: { pipelineConfig: {} } },
      {
        projectId: 'c',
        slug: 'c',
        createdBy: null,
        agentConfig: { pipelineConfig: { assistantWeekly: on } },
      },
      {
        projectId: 'd',
        slug: 'd',
        createdBy: 'u2',
        agentConfig: { pipelineConfig: { assistantWeekly: { ...on, enabled: false } } },
      },
    ]);
    expect((await listOptedInProjects(dbi)).map((p) => p.projectId)).toEqual(['a']);
  });
});
