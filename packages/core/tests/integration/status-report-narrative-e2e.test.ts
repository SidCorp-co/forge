import { shownFrame, type VisualBlock } from '@forge/contracts/visual-blocks';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { register } from '../../src/integrations/llm/registry.js';
import type { ChatMessage, ChatStreamEvent } from '../../src/integrations/llm/types.js';
import { api, type Body } from '../helpers/api.js';
import { type World, world } from '../helpers/forecast-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// A template report a schedule stores carries a narrative, and a finding per block, one model call
// wrote from the template's slot guidance and what this fire's blocks show of its own runs alone
// (the template run every door shares, `reports/templates.ts:runTemplate`), judged like any narrative (no
// number its blocks do not show). A refused answer gets one retry carrying the refusal; a second refusal, no model, or a
// project whose data policy forbids it stores the slots empty, names the reason in the notice and
// keeps which path ran on the report (REQ-32 criteria 7 and 8). The model is faked at the provider
// seam: the deployment's chat provider in the registry, behind the same `openChat` gate chat uses.

const asked: ChatMessage[][] = [];
let answers: string[] = [];

register('anthropic', () => ({
  id: 'scripted',
  defaultModel: 'scripted-model',
  async *stream(req): AsyncIterable<ChatStreamEvent> {
    asked.push(req.messages);
    yield { type: 'chunk', text: answers.shift() ?? '' };
    yield { type: 'usage', usage: { promptTokens: 120, completionTokens: 30 } };
    yield { type: 'done' };
  },
}));

const SLOTS = {
  summary: 'Work is under way.',
  risks: 'None are known from these rows.',
  recommendations: 'Keep taking the next issue.',
};
/** One finding per block the progress template draws over an empty project. */
const FINDINGS = [
  'Nothing moved in either period.',
  'No issue was filed or closed on any day.',
  'No status held any hours.',
  'No closed work served a requirement.',
  'No requirement stands on the roadmap.',
];
const CLEAN = { ...SLOTS, findings: FINDINGS };
const INVENTED = { ...CLEAN, summary: 'There are 98765 requirements.' };

let w: World;
beforeAll(async () => {
  w = await world();
}, 120_000);
beforeEach(() => {
  asked.length = 0;
  answers = [];
});

async function fire(on: World): Promise<{ id: string; detail: Body; notices: string[] }> {
  const created = await api(on.token, 'POST', '/api/schedules', {
    projectId: on.projectId,
    name: `Weekly progress ${Math.random()}`,
    cron: '0 9 * * 1',
    kind: 'status_report',
    timeZone: 'UTC',
    params: { recipients: [on.userId], templateId: 'progress' },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const fired = await api(on.token, 'POST', `/api/schedules/${created.body.id}/run`);
  expect(fired.status, JSON.stringify(fired.body)).toBe(202);
  const [row] = await db.execute<{ id: string }>(sql`
    SELECT id FROM status_reports WHERE schedule_id = ${String(created.body.id)}
  `);
  const id = String(row?.id);
  const opened = await api(on.token, 'GET', `/api/projects/${on.projectId}/status/reports/${id}`);
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const told = await db.execute<{ body: string }>(sql`
    SELECT body FROM notifications WHERE status_report_id = ${id}
  `);
  return { id, detail: opened.body, notices: [...told].map((n) => n.body) };
}

/** The report's Markdown export, as core serves it. */
const exportOf = async (on: World, id: string): Promise<string> => {
  const res = await api(
    on.token,
    'GET',
    `/api/projects/${on.projectId}/status/reports/${id}/export`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.body.text);
};

const usageOf = async (projectId: string) => [
  ...(await db.execute<{ model: string; request_count: number; input_tokens: number }>(sql`
      SELECT model, request_count, input_tokens FROM usage_records
      WHERE project_id = ${projectId} AND source = 'api' ORDER BY created_at
    `)),
];

describe('a scheduled template report writes its narrative', () => {
  it('stores the narrative the model wrote, from the slot guidance and what its blocks show alone', async () => {
    answers = [JSON.stringify(CLEAN)];
    const { id, detail, notices } = await fire(w);
    expect(await exportOf(w, id)).toContain('_Summary written by scripted-model._');
    expect(detail.narrative).toEqual({
      path: 'written',
      reason: null,
      model: 'scripted-model',
      calls: 1,
    });
    expect((detail.document as Body).narrative).toEqual(SLOTS);
    expect(((detail.document as Body).blocks as Body[]).map((b) => b.finding)).toEqual(FINDINGS);
    expect(asked).toHaveLength(1);
    const [system, input] = asked[0] as ChatMessage[];
    expect(String(system?.content)).toContain(
      'Nothing else from the project is given to you, so state nothing they do not hold.',
    );
    expect(String(system?.content)).toContain('English (`en`)');
    const blocks = (detail.document as Body).blocks as VisualBlock[];
    for (const block of blocks) {
      const shown = shownFrame(block);
      if (!shown) continue;
      expect(String(input?.content)).toContain(`### ${block.kind} "${block.title}"`);
      expect(String(input?.content)).toContain(`Rows: ${JSON.stringify(shown.rows)}`);
    }
    expect(String(input?.content)).not.toContain(w.projectId);
    for (const body of notices) {
      expect(body).toContain('Work is under way.');
      expect(body).not.toContain('not written');
    }
    expect(await usageOf(w.projectId)).toEqual([
      { model: 'scripted-model', request_count: 1, input_tokens: 120 },
    ]);
  });

  it('refuses a narrative with an invented number, and the one retry carrying the refusal stores a clean one', async () => {
    answers = [JSON.stringify(INVENTED), JSON.stringify(CLEAN)];
    const { id, detail } = await fire(w);
    expect(await exportOf(w, id)).toContain(
      '_Summary written by scripted-model on its one retry, after the first answer was refused._',
    );
    expect(detail.narrative).toEqual({
      path: 'retried',
      reason: null,
      model: 'scripted-model',
      calls: 2,
    });
    expect((detail.document as Body).narrative).toEqual(SLOTS);
    const retry = asked[1] as ChatMessage[];
    expect(String(retry.at(-1)?.content)).toContain(
      'states 98765, which no block of template "progress" shows',
    );
    const usage = await usageOf(w.projectId);
    expect(usage.at(-1)).toEqual({ model: 'scripted-model', request_count: 2, input_tokens: 240 });
  });

  it('stores the slots empty after two refusals, names the reason in the notice, and calls no third time', async () => {
    answers = [JSON.stringify(INVENTED), JSON.stringify(INVENTED), JSON.stringify(CLEAN)];
    const { id, detail, notices } = await fire(w);
    const exported = await exportOf(w, id);
    expect(exported).toContain("_Summary not written: the model's narrative was refused twice (");
    expect(exported).not.toContain('Narrative not written');
    expect(asked).toHaveLength(2);
    expect(detail.narrative).toMatchObject({
      path: 'not_written',
      model: 'scripted-model',
      calls: 2,
    });
    expect(String((detail.narrative as Body).reason)).toContain(
      "the model's narrative was refused twice (",
    );
    expect((detail.document as Body).narrative).toEqual({
      summary: '',
      risks: '',
      recommendations: '',
    });
    expect(notices.length).toBeGreaterThan(0);
    for (const body of notices) {
      expect(body).toContain("Summary not written: the model's narrative was refused twice");
    }
  });

  it('makes no call for a project whose data policy forbids sending data to a model, and says so', async () => {
    const closed = await world();
    await seedProjectDocument(closed.projectId, closed.userId, {
      environments: {},
      extra: { sensitiveData: 'no_egress' },
    });
    answers = [JSON.stringify(CLEAN)];
    const { detail, notices } = await fire(closed);
    expect(asked).toHaveLength(0);
    expect(detail.narrative).toEqual({
      path: 'not_written',
      reason:
        "the project's data policy forbids sending its data to a model, so no model was asked",
      model: null,
      calls: 0,
    });
    for (const body of notices) {
      expect(body).toContain(
        "Summary not written: the project's data policy forbids sending its data to a model, so no model was asked.",
      );
    }
    expect(await usageOf(closed.projectId)).toEqual([]);
  });

  it("writes in the project's content language when it declares one", async () => {
    const vi = await world();
    await seedProjectDocument(vi.projectId, vi.userId, {
      environments: {},
      extra: { contentLanguage: 'vi' },
    });
    answers = [JSON.stringify(CLEAN)];
    await fire(vi);
    expect(String((asked[0] as ChatMessage[])[0]?.content)).toContain('Vietnamese (`vi`)');
  });

  it('keeps which path ran on the stored row, and the row refuses a change to it', async () => {
    answers = [JSON.stringify(CLEAN)];
    const { id } = await fire(w);
    const [row] = await db.execute<{ narrative_outcome: Body }>(sql`
      SELECT narrative_outcome FROM status_reports WHERE id = ${id}
    `);
    expect(row?.narrative_outcome).toMatchObject({ path: 'written', calls: 1 });
    const changed = await db
      .execute(sql`
        UPDATE status_reports SET narrative_outcome = '{"path":"retried"}'::jsonb WHERE id = ${id}
      `)
      .then(
        () => 'changed',
        (err: Error & { cause?: Error }) => String(err.cause?.message ?? err.message),
      );
    expect(changed).toContain('STATUS_REPORT_IMMUTABLE');
  });
});
