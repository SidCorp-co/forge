/**
 * A resident session's Claude Code permission prompt is relayed by the box's `PermissionRequest`
 * hook as a question a person allows or denies (ISS-1268 B3, owner: "never silent"). Through the box's
 * door `POST /api/devices/me/questions` with `permissionPrompt`, it is a person's question on no issue
 * on any gate profile: the project's admins are rung at once, an agent's answer is refused, and a
 * person's allow or deny reads back on the box's waiter with the note it carried. Nobody answering
 * within the box's bound, the box ends it at `POST .../:id/expire`: the question is void with
 * `PERMISSION_RELAY_TIMEOUT` and the admins are told the call was denied. A dialog that slipped past
 * the relay, which the box's watcher read and answered itself (C2), is told the admins at
 * `POST /api/devices/me/session-prompts`, naming the session, the text and what it needs.
 */

// @direct-test-of packages/core/src/devices/pool-routes.ts
// @direct-test-of packages/core/src/questions/permission-prompt.ts
// @direct-test-of packages/core/src/questions/owed.ts
// @direct-test-of packages/core/src/notifications/notify-questions.ts
// @direct-test-of packages/core/src/notifications/notify-session-prompt.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  ok,
  openWorld,
  type Reply,
  refusalCodes,
  requester,
  settleOutbox,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestUser,
  rows,
} from '../helpers/factories.js';

let w: EcosystemWorld;
let projectId: string;
let ownerId: string;
let say: (
  who: 'owner' | 'master' | 'box',
  method: string,
  path: string,
  body?: Doc,
) => Promise<Reply>;

beforeAll(async () => {
  w = await openWorld();
  projectId = w.project.forge;
  ownerId = w.user.platform;
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { deviceTokenNameFor } = await import('../../src/credentials/pat-format.js');
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  const deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  say = requester(w.app, {
    owner: w.token.platform,
    master: (
      await mintPat({ permissions: ['*'], userId: agent, name: 'master', projectIds: [projectId] })
    ).plaintext,
    box: (
      await mintPat({
        userId: ownerId,
        name: deviceTokenNameFor(deviceId),
        permissions: ['*'],
        deviceId,
      })
    ).plaintext,
  });
}, 180_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

const options = [
  {
    id: 'allow',
    label: 'Allow',
    authority: 'admin',
    bindsTo: 'this_call',
    executedBy: 'agent',
    fingerprint: 'permission-prompt:p-1',
  },
  {
    id: 'deny',
    label: 'Deny',
    authority: 'writer',
    bindsTo: 'this_call',
    executedBy: 'agent',
    fingerprint: 'permission-prompt:p-1',
  },
];

/** One relayed prompt, as `forge-runner hook --relay` asks it, and the waiter it registers. */
async function relay(command: string, body: Doc = {}): Promise<{ id: string; runId: string }> {
  const runId = `permission-relay:s-1:${randomUUID()}`;
  const res = await say('box', 'POST', '/api/devices/me/questions', {
    id: randomUUID(),
    projectId,
    runId,
    prompt: `forge-master-forge stopped on a Claude Code permission prompt: Bash \`${command}\``,
    blockerKind: 'human',
    options,
    recommendedOptionId: 'deny',
    permissionPrompt: { session: 'forge-master-forge', tool: 'Bash', promptId: 'p-1' },
    ...body,
  });
  return { id: ok(res).questionId as string, runId };
}

const readBack = async (q: { id: string; runId: string }) =>
  ok(
    await say(
      'box',
      'GET',
      `/api/devices/me/questions/${q.id}?runId=${encodeURIComponent(q.runId)}`,
    ),
  ).answer as Doc | null;

const bell = (type: string) =>
  rows<{ title: string; state: string }>(sql`
    SELECT n.title, n.state FROM notifications n
      JOIN notification_delivery_members m ON m.notification_id = n.id
      JOIN notification_deliveries d ON d.id = m.delivery_id
     WHERE d.user_id = ${ownerId} AND n.type = ${type} ORDER BY n.created_at`);

describe('a relayed permission prompt is a person’s question', () => {
  it('is asked on no issue as a person’s on a standard project, and rings the admins at once', async () => {
    const q = await relay('rm -rf $D/nodes');
    const [row] = await rows<{ blocker_kind: string; issue_id: string | null; origin: Doc }>(
      sql`SELECT blocker_kind, issue_id, origin FROM agent_questions WHERE id = ${q.id}`,
    );
    expect(row).toEqual({
      blocker_kind: 'human',
      issue_id: null,
      origin: {
        kind: 'permission_prompt',
        session: 'forge-master-forge',
        tool: 'Bash',
        promptId: 'p-1',
      },
    });
    await settleOutbox();
    expect((await bell('question_asked')).map((n) => n.title)).toContainEqual(
      expect.stringContaining('rm -rf $D/nodes'),
    );
  });

  it('refuses an agent’s answer by name, and reads back a person’s deny with its note', async () => {
    const q = await relay('git push --force origin main');
    const byAgent = await say('master', 'POST', `/api/questions/${q.id}/answer`, {
      round: 1,
      optionId: 'allow',
      note: 'the master allows itself',
    });
    expect(refusalCodes(byAgent)).toContain('QUESTION_OWED_BY_PERSON');
    expect(await readBack(q)).toBeNull();
    ok(
      await say('owner', 'POST', `/api/questions/${q.id}/answer`, {
        round: 1,
        optionId: 'deny',
        note: 'never force-push main',
      }),
    );
    expect(await readBack(q)).toMatchObject({ optionId: 'deny', note: 'never force-push main' });
  });

  it('refuses one asked on an issue by name', async () => {
    const res = await say('box', 'POST', '/api/devices/me/questions', {
      id: randomUUID(),
      projectId,
      runId: randomUUID(),
      issueId: 'ISS-1',
      prompt: 'a prompt on an issue',
      blockerKind: 'human',
      options,
      recommendedOptionId: 'deny',
      permissionPrompt: { session: 'forge-master-forge', tool: 'Bash' },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('QUESTION_SHAPE_INVALID');
  });
});

describe('a relayed prompt nobody answers', () => {
  it('is ended by the box at its bound as PERMISSION_RELAY_TIMEOUT, and the admins are told', async () => {
    const q = await relay('rm -rf /srv/cache');
    const ended = ok(
      await say('box', 'POST', `/api/devices/me/questions/${q.id}/expire`, {
        runId: q.runId,
        projectId,
        waitedSeconds: 300,
      }),
    );
    expect(ended.voidReason).toMatch(/^PERMISSION_RELAY_TIMEOUT: .*forge-master-forge.*300 s/);
    const [row] = await rows<{ status: string; ended_reason: string }>(
      sql`SELECT status, ended_reason FROM agent_questions WHERE id = ${q.id}`,
    );
    expect(row).toEqual({ status: 'void', ended_reason: 'PERMISSION_RELAY_TIMEOUT' });
    await settleOutbox();
    expect((await bell('permission_relay_timeout')).map((n) => n.title)).toContainEqual(
      expect.stringContaining('PERMISSION_RELAY_TIMEOUT'),
    );
    const again = await say('box', 'POST', `/api/devices/me/questions/${q.id}/expire`, {
      runId: q.runId,
      projectId,
      waitedSeconds: 300,
    });
    expect(refusalCodes(again)).toContain('QUESTION_NOT_OPEN');
  });

  it('is never ended for a waiter the box did not register', async () => {
    const q = await relay('rm -rf /srv/other');
    const res = await say('box', 'POST', `/api/devices/me/questions/${q.id}/expire`, {
      runId: 'another-run',
      projectId,
      waitedSeconds: 300,
    });
    expect(res.status).toBe(404);
  });
});

describe('a dialog the box answered on a session itself', () => {
  it('rings the admins with the session, the dialog it read and the answer', async () => {
    ok(
      await say('box', 'POST', '/api/devices/me/session-prompts', {
        projectId,
        session: 'forge-master-forge',
        text: 'New MCP server found in this project\n❯ 1. Use this and all future MCP servers',
        needs: 'approve the project MCP server',
        by: 'safe',
        answer: 'Escape',
      }),
    );
    await settleOutbox();
    expect((await bell('session_prompt_answered')).map((n) => n.title)).toContainEqual(
      expect.stringMatching(
        /^forge-master-forge stood on «New MCP server found.*Escape, the safe answer/,
      ),
    );
  });

  it('refuses an answer it does not know by name', async () => {
    const res = await say('box', 'POST', '/api/devices/me/session-prompts', {
      projectId,
      session: 'forge-master-forge',
      text: 'x',
      by: 'enter',
      answer: 'Enter',
    });
    expect(res.status).toBe(400);
  });
});
