import { ReportRunSchema } from '@forge/contracts/report-queries';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { screenReplyAtDoor } from '../../src/messaging/reply-screen.js';
import { api } from '../helpers/api.js';
import { createTestProject } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';

// A figure an Agent reply states is held to the report runs its session made, read from the
// `report_runs` the run door stored (REQ-32, lane A8): the stored frame grounds it, an expired run
// grounds nothing, and a run of another project grounds nothing.

describe('a reply figure held to the stored runs', () => {
  let w: World;
  let run: ReturnType<typeof ReportRunSchema.parse>;
  let figure: number;

  const screen = (text: string, projectId = w.projectId) =>
    screenReplyAtDoor('web-agent-completion', {
      projectId,
      segments: [text],
      toolCalls: [],
      progress: null,
      question: 'Where does the release stand?',
      restResults: [JSON.stringify(run)],
    });
  const figureRules = (v: Awaited<ReturnType<typeof screen>>) =>
    v.ok ? [] : v.refusals.filter((r) => r.rule === 'figures-grounded');

  beforeAll(async () => {
    w = await world();
    const res = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/report-queries/progress-by-requirement/runs`,
      {},
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    run = ReportRunSchema.parse(res.body);
    const cells = run.frame.rows.flatMap((r) => Object.values(r));
    figure = (cells.find((c) => typeof c === 'number' && c > 0) as number | undefined) ?? 0;
    figure = figure || run.frame.rows.length;
  }, 120_000);

  it('passes a figure the stored run holds, and holds one it does not', async () => {
    expect(figureRules(await screen(`There are ${figure} issues in all.`))).toEqual([]);
    const held = figureRules(await screen('There are 987654 issues in all.'));
    expect(held.map((r) => r.quote)).toEqual(['987654']);
  });

  it('grounds nothing on a run of another project', async () => {
    const other = await createTestProject(w.userId);
    const held = figureRules(await screen(`There are ${figure} issues in all.`, other.id));
    expect(held.map((r) => r.quote)).toEqual([String(figure)]);
    expect(held[0]?.why).toContain('ran no report');
  });

  it('grounds nothing on a run past its keep', async () => {
    await db.execute(sql`
      UPDATE report_runs SET as_of = now() - interval '31 days', expires_at = now() - interval '1 day'
      WHERE id = ${run.runId}
    `);
    const held = figureRules(await screen(`There are ${figure} issues in all.`));
    expect(held.map((r) => r.quote)).toEqual([String(figure)]);
    expect(held[0]?.why).toContain('ran no report');
  });
});
