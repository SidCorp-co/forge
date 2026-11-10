import type { RunFlow } from '@forge/contracts/run-flow';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { ago, type World, world } from '../helpers/forecast-world.js';

// The Agents band's one chart (REQ-43 r3 BC-16): runs started and finished per day in the reader's
// zone, over the runs the run list counts. A chat is no run of the list, so it is never counted; a run
// started before the window counts only the day it finished; one still running only its start.
// @direct-test-of packages/core/src/runs/flow-read.ts
// @direct-test-of packages/core/src/runs/routes.ts

async function run(
  w: World,
  kind: string,
  startedAt: Date,
  finishedAt: Date | null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO pipeline_runs (project_id, kind, status, started_at, finished_at, metadata)
    VALUES (${w.projectId}, ${kind}, ${finishedAt ? 'completed' : 'running'}, ${startedAt.toISOString()}::timestamptz,
            ${finishedAt?.toISOString() ?? null}::timestamptz, '{}'::jsonb)`);
}

describe('the run flow read', () => {
  let w: World;
  let flow: RunFlow;

  beforeAll(async () => {
    w = await world();
    const now = new Date();
    await run(w, 'system', ago(0.2), ago(0.1));
    await run(w, 'system', ago(0.05), null);
    await run(w, 'system', ago(24 * 20), ago(0.1));
    await run(w, 'interactive', ago(0.2), ago(0.1));
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/runs/flow?tz=UTC`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    flow = res.body as unknown as RunFlow;
    expect(flow.days.at(-1)?.day).toBe(now.toISOString().slice(0, 10));
  });

  it("counts the list's runs as started on the day they began and finished on the day they ended", () => {
    const total = (k: 'started' | 'finished') => flow.days.reduce((n, d) => n + d[k], 0);
    expect(flow.days).toHaveLength(14);
    expect(total('started')).toBe(2);
    expect(total('finished')).toBe(2);
  });

  it('refuses a zone it cannot count a day in, by name', async () => {
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/runs/flow?tz=Mars/Base`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Mars/Base');
  });
});
