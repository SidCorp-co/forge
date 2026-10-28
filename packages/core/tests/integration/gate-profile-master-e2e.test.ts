/**
 * REQ-76 BC-9: on a yolo project a master is placed for a chat or direct request, and a chat files
 * the issue itself. Under standard (`master_admitted_only` and `chat_files_issue` enforced) a
 * project whose only waiting work is a person's draft issue and a draft requirement with a
 * proposed revision gets no master (`nothing_owed`), and a chat credential filing an issue is
 * refused CHAT_FILES_FEEDBACK_NOT_ISSUES naming the gate (BC-11). Under yolo the same requests
 * place a master whose nudge names each, a draft an agent filed is not a request, and the chat's
 * issue is filed. The profile is set through the gates door (BC-12).
 *
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/issues/requests-waiting.ts
 * @direct-test-of packages/core/src/requirements/requests-waiting.ts
 * @direct-test-of packages/core/src/issues/create-service.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
} from '../helpers/factories.js';
import { projectBuiltFrom } from '../helpers/pattern-world.js';

type Who = 'owner' | 'box' | 'chat';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
/** The project whose master is judged. */
let projectId = '';
let runnerId = '';
/** The project a chat files into, kept apart so its issues are not the master project's work. */
let chatProjectId = '';
let personIssueKey = '';
let requirementKey = '';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { CHAT_TURN_MENU, mintTurnCredential } = await import(
    '../../src/credentials/turn-credential.js'
  );
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  projectId = await projectBuiltFrom(ownerId, 'github.com/acme/gate-master');
  chatProjectId = await projectBuiltFrom(ownerId, 'github.com/acme/gate-chat');
  for (const p of [projectId, chatProjectId]) await addProjectMember(p, ownerId, 'owner');
  await addProjectMember(projectId, agentId, 'member');
  const deviceId = await createTestDevice(ownerId);
  runnerId = await bindTestRunner(projectId, deviceId);
  const resolved = await resolveTurnAuthority({
    userId: ownerId,
    projectId: chatProjectId,
    viaTokenId: null,
  });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  say = requester(app, {
    owner: await signUserToken(ownerId),
    box: (
      await mintPat({
        permissions: ['*'],
        userId: ownerId,
        name: 'box',
        deviceId,
        projectIds: [projectId],
      })
    ).plaintext,
    chat: (
      await mintTurnCredential({
        authority: resolved.authority,
        menu: CHAT_TURN_MENU,
        ttlMs: 10 * 60_000,
      })
    ).token,
  }) as typeof say;

  // the waiting requests: a draft issue a person filed, and a draft requirement proposed from a chat
  personIssueKey = (
    await createTestIssue(projectId, ownerId, 1, { status: 'draft', createdAt: new Date() })
  ).key;
  // a draft an agent filed is its own work in progress, not a person's request
  await createTestIssue(projectId, agentId, 2, { status: 'draft', createdAt: new Date() });
  const made = ok(
    await say('owner', 'POST', `/api/projects/${projectId}/requirements`, {
      title: 'Reminders reach the nurse',
      reason: 'asked for in a chat',
      criteria: [{ body: 'A nurse sees the reminder' }],
    }),
    201,
  );
  requirementKey = String(made.key);
  ok(
    await say(
      'owner',
      'POST',
      `/api/projects/${projectId}/requirements/${requirementKey}/revisions/1/propose`,
      {},
    ),
  );
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** `project`'s gate profile, through the gates door with a reason, as a person sets it. */
async function profile(project: string, name: 'standard' | 'yolo'): Promise<void> {
  const read = ok(await say('owner', 'GET', `/api/projects/${project}/gates`));
  ok(
    await say('owner', 'PUT', `/api/projects/${project}/gates`, {
      baseRevision: read.revision,
      profile: name,
      overrides: {},
      reason: `planted: ${name} for the master and chat test`,
    }),
  );
}

function facts(): Doc {
  return {
    restarting: null,
    terminal: true,
    standing: 'proceed',
    pane: 'absent',
    capability: null,
    serversReadable: true,
    work: { poolWaits: false, jobPanes: 0 },
    conversation: { id: 'conv-1', transcript: 'present', elsewhere: 'none' },
    placement: null,
    holding: { kind: 'nothing' },
    turn: { kind: 'ended' },
    idle: {
      noWorkForSeconds: 0,
      pane: null,
      children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
    },
    limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
    nudge: { last: null, since: 'unreported' },
  };
}

const verdict = async (): Promise<Doc> =>
  ok(
    await say('box', 'POST', '/api/devices/me/master-session/verdict', {
      projectId,
      runnerId,
      facts: facts(),
    }),
  );

describe('REQ-76 BC-9: a master for a chat or direct request', () => {
  it('standard places none while only requests wait', async () => {
    await profile(projectId, 'standard');
    const answer = await verdict();
    expect(answer.verdict).toMatchObject({ act: 'withhold', reason: 'nothing_owed' });
    expect(answer.work).toMatchObject({ admissible: 0, owed: 0 });
  });

  it("yolo places one, its nudge naming the person's draft issue and the proposed requirement", async () => {
    await profile(projectId, 'yolo');
    const answer = await verdict();
    expect(answer.verdict).toMatchObject({ act: 'place' });
    expect(answer.work.owed).toBe(2);
    const nudge = String(answer.work.nudge);
    expect(nudge).toContain('gate master_admitted_only off');
    expect(nudge).toContain(
      `1 draft issue a person filed waits to be taken on (${personIssueKey})`,
    );
    expect(nudge).toContain(
      `1 draft requirement has a proposed revision waiting (${requirementKey})`,
    );
  });
});

describe('REQ-76 BC-9: a chat files the issue itself under yolo', () => {
  const wish = {
    title: 'The reminder panel opens at its full width',
    description: 'Asked for in a chat: open the panel at its full width.',
    status: 'draft',
  };

  it('standard refuses the chat credential CHAT_FILES_FEEDBACK_NOT_ISSUES, naming the gate', async () => {
    await profile(chatProjectId, 'standard');
    const r = await say('chat', 'POST', `/api/projects/${chatProjectId}/issues`, wish);
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    const [first] = r.json?.error?.refusals ?? [];
    expect(first?.code).toBe('CHAT_FILES_FEEDBACK_NOT_ISSUES');
    expect(first?.detail).toContain(
      "Gate chat_files_issue is enforced by this project's gate profile standard (gates.profile); gates.overrides.chat_files_issue relaxes it.",
    );
  });

  it('yolo files it', async () => {
    await profile(chatProjectId, 'yolo');
    const r = await say('chat', 'POST', `/api/projects/${chatProjectId}/issues`, wish);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  });
});
