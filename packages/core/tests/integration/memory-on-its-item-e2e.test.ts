import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import { ago, issue, requirement, type World, world } from '../helpers/forecast-world.js';

// REQ-33 BC-4, BC-5: a memory is read on the requirement, workflow or issue it names, not on a
// project Memory page. `cites` lists the memories whose text names that one record of this project,
// and a person who retires one from there takes it out of what the assistant recalls.

type Entry = Record<string, unknown> & { id: string; sourceRef: string };

async function citing(w: World, ref: string, state = 'live'): Promise<Body> {
  const res = await api(
    w.token,
    'GET',
    `/api/memory/entries?projectId=${w.projectId}&cites=${encodeURIComponent(ref)}&state=${state}`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const refs = (b: Body) => (b.items as Entry[]).map((r) => r.sourceRef).sort();

async function note(w: World, sourceRef: string, textContent: string) {
  const res = await api(w.token, 'POST', '/api/memory', {
    projectId: w.projectId,
    source: 'note',
    sourceRef,
    textContent,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function recall(w: World, query: string): Promise<string[]> {
  const res = await api(w.token, 'POST', '/api/memory/search', {
    projectId: w.projectId,
    strategy: 'keyword',
    query,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.hits as { sourceRef: string }[]).map((h) => h.sourceRef);
}

describe('a memory read on the record it names', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
    await requirement(w, 'Referral reports'); // REQ-1
    await issue(w, { status: 'open', createdAt: ago(2) }); // ISS-1
    await db.execute(sql`
      INSERT INTO project_workflows (project_id, flow, kind, revision, document, written_by_user, updated_at)
      VALUES (${w.projectId}, 'referral-intake', 'flow', 1, '{"title":"Referral intake"}'::jsonb, ${w.userId}, now() + interval '1 hour')
    `);
    await note(
      w,
      'gotcha/req1',
      'Referral reports keep the clinic name (REQ-1), agreed with the owner.',
    );
    await note(w, 'gotcha/iss1', 'The export button sits on the report (ISS-1).');
    await note(w, 'gotcha/req10', 'Wholly different record REQ-10 is not REQ-1 by prefix.');
    await note(w, 'gotcha/req10-only', 'Only REQ-10 here, and REQ-100.');
    await note(w, 'gotcha/elsewhere', 'The sibling tracker decided plugin REQ-1 differently.');
    await note(w, 'gotcha/flow', 'The referral-intake workflow asks for consent before the visit.');
    await note(
      w,
      'gotcha/no-flow',
      'The discharge-summary workflow is not one this project draws.',
    );
  });

  it('lists the memories that name the requirement by its key, never one naming a longer key or another project', async () => {
    const read = await citing(w, 'REQ-1');
    expect(refs(read)).toEqual(['gotcha/req1', 'gotcha/req10']);
    expect(read.counts).toMatchObject({ live: 2, retired: 0 });
    const row = (read.items as Entry[]).find((r) => r.sourceRef === 'gotcha/req1') as Entry;
    expect(row.writtenBy).toMatchObject({ id: w.userId, agent: false });
    expect(row.writtenAt).toEqual(expect.any(String));
    expect(row).toHaveProperty('verifiedAt', null);
  });

  it('lists an issue’s memories by its key, and a workflow’s by its flow as a whole word', async () => {
    expect(refs(await citing(w, 'ISS-1'))).toEqual(['gotcha/iss1']);
    expect(refs(await citing(w, 'referral-intake'))).toEqual(['gotcha/flow']);
    expect(refs(await citing(w, 'intake'))).toEqual([]);
    expect(refs(await citing(w, 'discharge-summary'))).toEqual([]);
  });

  it('resolves a workflow cite like a key: linked, and changed once the workflow moved after the memory', async () => {
    const row = ((await citing(w, 'referral-intake')).items as Entry[])[0] as Entry;
    expect(row.cites).toEqual([
      expect.objectContaining({ ref: 'referral-intake', kind: 'workflow', state: 'resolved' }),
    ]);
    expect(row.changed).toEqual([
      expect.objectContaining({ ref: 'referral-intake', kind: 'workflow' }),
    ]);
    expect(row.needsCheck).toContain('changed');
  });

  it('refuses a cites that is neither a key nor a flow, naming the shape', async () => {
    const res = await api(
      w.token,
      'GET',
      `/api/memory/entries?projectId=${w.projectId}&cites=${encodeURIComponent('REQ 1; drop')}`,
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('cites is an issue or requirement key');
  });

  it('corrected from the item with a reason, the memory keeps its old text as a revision', async () => {
    const row = ((await citing(w, 'ISS-1')).items as Entry[])[0] as Entry;
    const res = await api(
      w.token,
      'POST',
      `/api/memory/${row.id}/correct?projectId=${w.projectId}`,
      {
        text: 'The export button sits in the report header (ISS-1).',
        reason: 'Checked against the running build',
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const now = ((await citing(w, 'ISS-1')).items as Entry[])[0] as Entry;
    expect(now.text).toBe('The export button sits in the report header (ISS-1).');
    expect(now.corrections).toEqual([
      expect.objectContaining({ reason: 'Checked against the running build' }),
    ]);
    const kept = await api(
      w.token,
      'GET',
      `/api/memory/revisions?projectId=${w.projectId}&memoryId=${row.id}`,
    );
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(JSON.stringify(kept.body.items)).toContain(
      'The export button sits on the report (ISS-1).',
    );
  });

  it('retired from the item, a memory leaves the item’s list and the assistant’s recall, and says who and why', async () => {
    expect(await recall(w, 'clinic name')).toContain('gotcha/req1');
    const row = ((await citing(w, 'REQ-1')).items as Entry[]).find(
      (r) => r.sourceRef === 'gotcha/req1',
    ) as Entry;
    const res = await api(
      w.token,
      'POST',
      `/api/memory/${row.id}/retire?projectId=${w.projectId}`,
      {
        reason: 'The clinic name moved to the header in revision 3',
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(refs(await citing(w, 'REQ-1'))).toEqual(['gotcha/req10']);
    expect(await recall(w, 'clinic name')).not.toContain('gotcha/req1');
    const retired = await citing(w, 'REQ-1', 'retired');
    expect(refs(retired)).toEqual(['gotcha/req1']);
    expect((retired.items as Entry[])[0]?.retired).toMatchObject({
      reason: 'The clinic name moved to the header in revision 3',
      by: expect.objectContaining({ id: w.userId }),
    });
    expect(retired.counts).toMatchObject({ live: 1, retired: 1 });
  });
});
