/**
 * ISS-1066 — what a result file says about the project it was taken against, and about a task the
 * project could not be asked. Split out of `run.test.ts`, which was at the 500-line file budget.
 */

import { describe, expect, it } from 'vitest';
import { readResult } from './result.js';

describe('the project a run was taken against (ISS-1066)', () => {
  const base = {
    at: '2026-09-17T00:00:00.000Z',
    api: 'https://beta',
    commit: 'abc',
    version: '0.3.0',
    model: 'm',
    runId: 'r',
    k: 3,
    tasks: [{ id: 'a', capability: 'method', trials: [] }],
  };

  it('reads a file written before ISS-1066 as project null rather than refusing it', () => {
    const read = readResult(JSON.stringify(base));
    expect(read.project).toBeNull();
  });

  it('reads the project block back whole where a file carries one', () => {
    const project = {
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'forge-plugin',
      brief: '# Forge plugin\nopen 682',
      readAt: '2026-09-17T00:00:00.000Z',
    };
    const read = readResult(JSON.stringify({ ...base, project }));
    expect(read.project).toEqual(project);
  });

  it('reads a task recorded not applicable back with its reason and no trials', () => {
    const read = readResult(
      JSON.stringify({
        ...base,
        tasks: [
          {
            id: 'project-waiting-issue',
            capability: 'project-understanding',
            trials: [],
            notApplicable: 'the project holds no issue waiting on information',
          },
        ],
      }),
    );
    expect(read.tasks[0]?.notApplicable).toBe('the project holds no issue waiting on information');
    expect(read.tasks[0]?.trials).toEqual([]);
  });
});
