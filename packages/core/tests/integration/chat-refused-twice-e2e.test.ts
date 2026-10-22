/**
 * REQ-41 BC-28, dev 2026-10-21 (conversation a760cd5f): the chat offered a Feedback item four times
 * and each press of Record it failed, three of them FEEDBACK_TARGET_NOT_ONE. An act refused twice on
 * one target in one conversation is not offered a third time: the offer is refused by name, the
 * defect is filed into Forge's own feedback (joined to the open item on a later offer), and the model
 * is told to say so. Real gate, real toolset, real database.
 *
 * @direct-test-of packages/core/src/assistant/agreement/refused-twice.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgreementWorld, openAgreementWorld } from '../helpers/chat-agreement-world.js';
import { closeWorld } from '../helpers/ecosystem-world.js';
import { createTestProject, rows } from '../helpers/factories.js';

let w: AgreementWorld;
const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((b) => b.text ?? '').join('\n');

// the refusal the dev presses met, as the proposal kept it
const TARGET_NOT_ONE = JSON.stringify({
  type: 'urn:forge:refusal:FEEDBACK_TARGET_NOT_ONE',
  title: 'Feedback target not one',
  status: 422,
  detail:
    'an item is about one target, and this names requirement and issue and release and workflow and endpoint and screen; name exactly one of requirement, issue, release, workflow, endpoint or screen.',
});
const HOLD_STDERR = JSON.stringify({
  exitCode: 1,
  stdout: '',
  stderr:
    'Hold — this writes to ISS-549, and every comment on the page the tracker returns that this session has not been shown is below.',
});

/** A press that failed, as the agreement door leaves it. */
async function failedPress(
  kind: 'feedback' | 'comment',
  name: string,
  args: unknown,
  failure: string,
) {
  const store = await import('../../src/assistant/agreement/store.js');
  const row = await store.recordProposal({
    projectId: w.projectId,
    conversationId: w.roomId,
    proposedTo: w.owner,
    handleUserId: null,
    sessionId: null,
    kind,
    form: 'tool',
    call: { name, arguments: JSON.stringify(args) },
    body: null,
    summary: { title: 'planted', lines: [], relates: [] },
  });
  await store.claimAgreement(row.id, w.owner);
  await store.settleProposal(row.id, { ok: false, failure });
  return row.id;
}

// the dev calls named six targets; each failed press is planted with the call it held
const devFeedback = (title: string) => ({
  kind: 'change_request',
  severity: 'high',
  title,
  requirement: 'REQ-41',
  issue: 'ISS-549',
  screen: '/projects/forge/issues',
});
const offer = (title: string) =>
  JSON.stringify({ kind: 'bug', title, target: { kind: 'screen', ref: '/projects/forge/issues' } });

const pending = async () =>
  rows<{ id: string; kind: string }>(sql`
    SELECT id, kind FROM chat_proposals WHERE conversation_id = ${w.roomId} AND status = 'pending'`);
const homeItems = (homeId: string) =>
  rows<{ fb_seq: number; title: string; signal_key: string; occurrences: number }>(sql`
    SELECT f.fb_seq, f.title, f.signal_key,
           (SELECT count(*)::int FROM feedback_occurrences o WHERE o.feedback_id = f.id) AS occurrences
      FROM feedback f WHERE f.project_id = ${homeId} ORDER BY f.fb_seq`);

beforeAll(async () => {
  w = await openAgreementWorld('Record what I said about Record it.');
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('an act refused twice on one target is not offered a third time (REQ-41 BC-28)', () => {
  it('holds the next offer after one failed press, and a declined card is no refusal', async () => {
    await failedPress(
      'feedback',
      'project_feedback',
      devFeedback(
        'Closing or dropping an issue must resolve its open questions in the same simple action',
      ),
      TARGET_NOT_ONE,
    );
    const r = await w
      .gate()
      .tools.execute('project_feedback', offer('Record it must record a chat proposal'));
    expect(text(r)).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
    const [card] = await pending();
    expect(card?.kind).toBe('feedback');
    const declined = await w.say(
      'owner',
      'POST',
      `/api/conversations/${w.roomId}/proposals/${card?.id}/decline`,
    );
    expect(declined.status).toBe(200);
    const again = await w
      .gate()
      .tools.execute('project_feedback', offer('Record it must record a chat proposal'));
    expect(text(again)).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
    for (const p of await pending())
      await w.say('owner', 'POST', `/api/conversations/${w.roomId}/proposals/${p.id}/decline`);
  });

  it('refuses the third offer by name, naming both failures, and says when Forge has nowhere to record it', async () => {
    await failedPress(
      'feedback',
      'project_feedback',
      devFeedback(
        'Record it must reliably record a chat proposal and explain any blocking error in context',
      ),
      TARGET_NOT_ONE,
    );
    const r = await w
      .gate()
      .tools.execute('project_feedback', offer('Record it creates an invalid proposal'));
    expect(r.isError).toBe(true);
    const said = text(r);
    expect(said).toMatch(
      /^\{"error":"CHAT_WRITE_REFUSED_TWICE: the person pressed Record it on this Feedback item 2 times/,
    );
    expect(said.match(/FEEDBACK_TARGET_NOT_ONE/g)).toHaveLength(2);
    expect(said).toContain(
      'Forge could not record this defect in its own feedback (FORGE_HOME_NOT_SET',
    );
    expect(said).toContain('do not offer this Feedback item again in this conversation');
    expect(await pending(), 'nothing is held, so no card is drawn').toEqual([]);
  });

  it("files the defect into Forge's home project once, and a later offer joins the same item", async () => {
    const home = await createTestProject(w.owner);
    await rows(sql`
      INSERT INTO instance_settings (id, forge_home_project_id, revision, updated_by)
      VALUES (1, ${home.id}, 1, ${w.owner})
      ON CONFLICT (id) DO UPDATE SET forge_home_project_id = EXCLUDED.forge_home_project_id`);
    const gate = w.gate();
    const first = text(
      await gate.tools.execute('project_feedback', offer('Record it fails again')),
    );
    const retried = text(
      await gate.tools.execute('project_feedback', offer('Record it fails again, worded anew')),
    );
    expect(first).toMatch(
      /Forge recorded the defect in its own feedback as FB-\d+; tell the person so/,
    );
    expect(retried, 'a retry in the same turn is answered the same, and files nothing more').toBe(
      first,
    );
    const later = text(
      await w.gate().tools.execute('project_feedback', offer('Record it, a third time')),
    );
    expect(later).toMatch(
      /Forge added this to FB-\d+, already open in its own feedback for the same failure/,
    );
    const items = await homeItems(home.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "The chat's Feedback item on this project failed each time it was pressed",
      signal_key: 'chat:refused-twice:feedback:FEEDBACK_TARGET_NOT_ONE',
      occurrences: 2,
    });
  });

  it('counts each target apart: a comment refused twice on ISS-549 still lets one on another issue be held', async () => {
    const comment = (key: string) => ({ argv: ['comment', key, '-'], body: '' });
    await failedPress('comment', 'forge', comment('ISS-549'), HOLD_STDERR);
    await failedPress('comment', 'forge', comment('ISS-549'), HOLD_STDERR);
    const other = await w
      .gate()
      .tools.execute('forge', JSON.stringify({ argv: ['comment', 'ISS-1', '-'], body: 'Fine.' }));
    expect(text(other)).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
    const same = await w
      .gate()
      .tools.execute(
        'forge',
        JSON.stringify({ argv: ['comment', 'iss-549', '-'], body: 'Again.' }),
      );
    expect(text(same)).toContain(
      'CHAT_WRITE_REFUSED_TWICE: the person pressed Record it on this comment 2 times',
    );
    expect(text(same)).toContain('UNNAMED (Hold — this writes to ISS-549');
  });
});
