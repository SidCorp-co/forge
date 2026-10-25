/**
 * REQ-65 BC-1, BC-2, REQ-66 BC-2 (ISS-690): every request passes one value check before it becomes a
 * requirement or open feedback. It is checked, from every door, for who it is for, what improves, how
 * that is measured and whether it already exists; it ends as accept, merge, a better alternative or
 * refuse with a reason; and a feedback item's triage follows the check, declining one of no value
 * with the reason. Its questions, holds and keeps: value-check-answers-e2e.test.ts.
 *
 * Driven through the real app on a throwaway Postgres, the model a stub gateway on a local port
 * (helpers/value-check-world.ts).
 *
 * @direct-test-of packages/core/src/intake/value-rules.ts
 * @direct-test-of packages/core/src/requirements/value-refusal.ts
 */

import type { IntakeDraftView } from '@forge/contracts/intake-drafts';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, patToken } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import {
  create,
  draftOf,
  REFUSE_REASON,
  seen,
  statusOf,
  useValueCheckWorld,
  world,
} from '../helpers/value-check-world.js';

useValueCheckWorld();
let projectId: string;
let ownerId: string;
let owner: string;
beforeAll(() => {
  ({ projectId, ownerId, owner } = world);
});

describe('every request is checked for who, what improves, how it is measured and whether it exists (REQ-65 BC-1)', () => {
  const checked = (d: IntakeDraftView | null) => ({
    who: d?.value?.who?.value,
    improves: d?.value?.improves?.value,
    measured: d?.value?.measured?.value,
    exists: d?.value?.exists ?? null,
    outcome: d?.value?.outcome?.kind,
  });
  const ACCEPTED = {
    who: 'Referral clerk',
    improves: 'Fewer referrals reach the wrong patient',
    measured: 'Wrong matches per week',
    exists: null,
    outcome: 'accept',
  };

  it('checks a requirement created through the web and API door', async () => {
    const key = await create('Accept: Match the clinic code on every referral');
    expect(checked(await draftOf(key))).toEqual(ACCEPTED);
    expect(seen.at(-1)?.system).toContain('"value": the one value check every request passes');
  });

  it('checks a requirement created through the MCP door the chat speaks through', async () => {
    const pat = await patToken(ownerId, [projectId]);
    const res = await api(
      pat,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'forge_requirements',
          arguments: {
            action: 'create',
            projectId,
            title: 'Accept: Match referrals by clinic code from chat',
          },
        },
      },
      { accept: 'application/json, text/event-stream' },
    );
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
    const text =
      (res.body as { result: { content: { text: string }[] } }).result.content[0]?.text ?? '';
    const key = (JSON.parse(text) as { requirement: { key: string } }).requirement.key;
    await settleOutbox();
    expect(checked(await draftOf(key))).toEqual(ACCEPTED);
  });

  it('checks feedback filed through its door and through the report every page files', async () => {
    const filed = await api(owner, 'POST', `/api/projects/${projectId}/feedback`, {
      kind: 'bug',
      title: 'Accept: A referral matched by name, not its clinic code.',
      requirement: 'REQ-1',
    });
    expect(filed.status, JSON.stringify(filed.body).slice(0, 400)).toBe(201);
    const reported = await api(owner, 'POST', `/api/projects/${projectId}/feedback/report`, {
      said: 'Accept: The board matched a referral by name, not its clinic code.',
      whereSeen: '/projects/demo/requirements/REQ-1',
      kind: 'bug',
    });
    expect(reported.status, JSON.stringify(reported.body).slice(0, 400)).toBe(201);
    await settleOutbox();
    for (const res of [filed, reported]) {
      const key = (res.body as { feedback: { key: string } }).feedback.key;
      expect(checked(await draftOf(key)), key).toEqual(ACCEPTED);
    }
  });
});

describe('the check ends as accept, merge, a better alternative, or refuse with a reason (REQ-65 BC-2)', () => {
  it('accepts: the request stays a draft and moves on', async () => {
    const key = await create('Accept: Flag a referral with no clinic code');
    expect((await draftOf(key))?.value?.outcome).toEqual({ kind: 'accept' });
    expect(await statusOf(key)).toBe('draft');
  });

  it('merges into the item it repeats, proposing it as that item’s duplicate', async () => {
    const key = await create('Merge: Match each referral by its clinic code');
    const value = (await draftOf(key))?.value;
    expect(value?.exists?.ref.key).toBe('REQ-1');
    expect(value?.outcome).toMatchObject({ kind: 'merge', into: { key: 'REQ-1' } });
    expect(value?.effect?.as).toBe('suggestion');
    const sugg = await rows<{ kind: string; payload: { duplicateOf: string } }>(
      sql`SELECT s.kind, s.payload FROM suggestions s JOIN requirements r ON r.id = s.requirement_id
          WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))}`,
    );
    expect(sugg.map((s) => [s.kind, s.payload.duplicateOf])).toEqual([['duplicate', 'REQ-1']]);
  });

  it('offers a better alternative and leaves the request a draft', async () => {
    const key = await create('Alternative: Email the clinic code to the clerk');
    expect((await draftOf(key))?.value?.outcome).toMatchObject({
      kind: 'alternative',
      instead: 'Show the clinic code on the referral list.',
      ref: { key: 'REQ-1' },
    });
    expect(await statusOf(key)).toBe('draft');
  });

  it('refuses with its one-line reason: the requirement is refused, kept, and its history says why', async () => {
    const key = await create('Refuse: Paint the header purple');
    const draft = await draftOf(key);
    expect(draft?.value?.outcome).toEqual({ kind: 'refuse', reason: REFUSE_REASON });
    expect(draft?.value?.effect).toEqual({ as: 'refused' });
    expect(await statusOf(key)).toBe('refused');
    const [move] = await rows<{ reason: string; actor_type: string }>(
      sql`SELECT t.reason, t.actor_type FROM kernel_transitions t JOIN requirements r ON r.id = t.entity_id
          WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))} AND t.to_status = 'refused'`,
    );
    expect(move).toEqual({ reason: REFUSE_REASON, actor_type: 'system' });
  });

  it('declines a feedback item of no value in its triage, the reason its note (REQ-66 BC-2)', async () => {
    const res = await api(owner, 'POST', `/api/projects/${projectId}/feedback`, {
      kind: 'idea',
      title: 'Refuse: Make the header purple.',
      screen: 'The page header',
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);
    await settleOutbox();
    const key = (res.body as { feedback: { key: string } }).feedback.key;
    expect((await draftOf(key))?.value?.outcome).toEqual({ kind: 'refuse', reason: REFUSE_REASON });
    const sugg = await rows<{ payload: { route: string; note: string } }>(
      sql`SELECT s.payload FROM suggestions s JOIN feedback f ON f.id = s.feedback_id
          WHERE f.project_id = ${projectId} AND f.fb_seq = ${Number(key.slice(3))}`,
    );
    expect(sugg.map((s) => [s.payload.route, s.payload.note])).toEqual([
      ['decline', REFUSE_REASON],
    ]);
  });
});
