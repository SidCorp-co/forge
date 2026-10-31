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
 * @direct-test-of packages/core/src/project-config/master-mode.ts
 * @direct-test-of packages/core/src/issues/requests-waiting.ts
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/requirements/requests-waiting.ts
 * @direct-test-of packages/core/src/issues/create-service.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
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
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

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

// owner, 2026-10-30: the pass prompt the box types is core's, so which way the master works is read
// from the project's declarations here: yolo with fast delivery on builds direct, anything else
// dispatches as before.
describe('the pass prompt under direct mode (gate profile yolo, fast delivery on)', () => {
  const nudge = async () => String((await verdict()).work.nudge);
  const fast = async (on: boolean) =>
    db.execute(sql`
      UPDATE project_config_documents
         SET document = jsonb_set(document, '{delivery}', ${JSON.stringify({ fast: on })}::jsonb)
       WHERE project_id = ${projectId}`);

  it('tells a yolo master that delivers fast to build and record, and names no dispatch', async () => {
    await profile(projectId, 'yolo');
    const said = await nudge();
    expect(said).toContain("This project's master works direct");
    expect(said).toContain('Dispatch no runner role');
    expect(said).not.toContain('Run the wave by');
  });

  it('dispatches as before once fast delivery is off, and under standard', async () => {
    await profile(projectId, 'yolo');
    await fast(false);
    try {
      expect(await nudge()).toMatch(
        /^Pass\. Run the wave by `forge-runner api guides\/dispatch\.md`/,
      );
    } finally {
      await fast(true);
    }
    await profile(projectId, 'standard');
    const said = await nudge();
    expect(said).toMatch(/^Pass\. Run the wave by `forge-runner api guides\/dispatch\.md`/);
    expect(said).not.toContain('works direct');
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

// ISS-840 (FB-434, epod 2026-10-31): FB-6 was triaged to the draft ISS-26, and its standing named the
// master as the one to take it on. The master's owed read counted a draft only as a person's request,
// and asked for none under master_admitted_only, so no master was placed for 13 h. A draft a triage
// routed an item to is master work under every profile (REQ-68 BC-6: no page asks a person to act).
describe('a draft a feedback triage routed an item to', () => {
  let carrierKey = '';

  beforeAll(async () => {
    // the fixtures above wrote ISS-1 and ISS-2 by number, past the counter a filed issue takes its from
    await db.execute(sql`
      INSERT INTO project_iss_counters (project_id, next_seq) VALUES (${projectId}, 100)
      ON CONFLICT (project_id) DO UPDATE SET next_seq = 100`);
    const at = (path: string) => `/api/projects/${projectId}${path}`;
    const fb = ok(
      await say('owner', 'POST', at('/feedback'), {
        kind: 'bug',
        title: 'The reminder never reaches the nurse',
        screen: '/reminders',
      }),
      201,
    ).feedback.key as string;
    ok(
      await say('owner', 'POST', at(`/feedback/${fb}/triage`), {
        answers: TRIAGE_ANSWERS,
        route: 'issue',
        createIssue: { complexity: 's' },
      }),
    );
    const read = ok(await say('owner', 'GET', at(`/feedback/${fb}`))).feedback;
    carrierKey = String(read.route.carriers[0].key);
  });

  it('places a master under standard, its nudge naming the draft, though the gate holds requests', async () => {
    await profile(projectId, 'standard');
    const answer = await verdict();
    expect(answer.verdict, JSON.stringify(answer.verdict)).toMatchObject({ act: 'place' });
    expect(answer.work.owed).toBe(1);
    expect(String(answer.work.nudge)).toContain(
      `1 draft issue carries triaged feedback and waits to be taken on (${carrierKey})`,
    );
  });

  it("is named once under yolo, as the carrier it is and not again as a person's request", async () => {
    await profile(projectId, 'yolo');
    const nudge = String((await verdict()).work.nudge);
    expect(nudge).toContain(`waits to be taken on (${carrierKey})`);
    expect(nudge.split(carrierKey)).toHaveLength(2);
  });
});
