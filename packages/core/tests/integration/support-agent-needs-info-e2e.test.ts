import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import type { QuestionOption } from '../../src/db/schema-questions.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  rows,
} from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { refusalCodes, SupportWorld, type Turn } from '../helpers/support-world.js';

/**
 * @direct-test-of packages/core/src/support/ops-waiting.ts
 * @direct-test-of packages/core/src/support/ops-reads.ts
 * @direct-test-of packages/core/src/support/tool.ts
 * @direct-test-of packages/core/src/support/prompt.ts
 */

// ISS-877 (FB-472, agenfold owner group, 2026-11-02): asked what the owner owes, the channel agent
// read support.issues, got key, title and status, and sent the owner to look the question up
// himself. A parked issue now carries what it waits on, in plain words beside every id: the open
// question as asked, its options, and who owes the answer, read from the issue's own standing and
// the open person questions Needs you reads. The read spans the projects the agent follows (ISS-874)
// and refuses one outside them.

const w = new SupportWorld();
let chat: StandInRocketChat;
const tag = randomUUID().slice(0, 6);
const HOME = `agenfold-api-${tag}`;
const FE = `agenfold-web-${tag}`;
const OUTSIDE = `elsewhere-${tag}`;
const OWNER_NAME = 'Hùng Trần';
const PROMPT = 'Which onboarding tour should new workspaces see first?';
const OPTIONS: QuestionOption[] = [
  {
    id: 'short',
    label: 'The short tour',
    authority: 'writer',
    bindsTo: 'session',
    executedBy: 'agent',
  },
  {
    id: 'full',
    label: 'The full tour',
    authority: 'writer',
    bindsTo: 'session',
    executedBy: 'agent',
  },
];
const CHECK = {
  name: 'morning',
  at: '01:30',
  ask: 'What is blocked, and what the owner owes.',
};

type Act = (a: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Run `model` on the next check turn `fire` hands the agent, and wait until it ran. */
async function onCheckTurn(fire: () => Promise<unknown>, model: (act: Act) => Promise<void>) {
  await w.settleWarm();
  let seen: Turn | null = null;
  let done = false;
  w.box.model = async (turn, act) => {
    if (seen || !turn.messages.some((m) => m.thread.startsWith('check:'))) return;
    seen = turn;
    await model(act);
    done = true;
  };
  await fire();
  await expect.poll(() => done, { timeout: 15_000 }).toBe(true);
}

type Row = { key: string; status: string; waiting?: Record<string, unknown> };
const issuesOf = (body: Record<string, unknown> | undefined) => (body?.issues ?? []) as Row[];

/** Every read the agent makes in one check turn, by name. */
async function readAll(day: string): Promise<Record<string, Record<string, unknown>>> {
  const { fireDueChecks } = await import('../../src/support/index.js');
  const out: Record<string, Record<string, unknown>> = {};
  await onCheckTurn(
    () => fireDueChecks(new Date(`${day}T01:30:00Z`)),
    async (act) => {
      out.feParked = await act({ action: 'issues', project: FE, status: 'needs_info' });
      out.fe = await act({ action: 'issues', project: FE });
      out.home = await act({ action: 'issues', project: HOME });
      out.outside = await act({ action: 'issues', project: OUTSIDE });
    },
  );
  return out;
}

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  await db.execute(
    sql`UPDATE users SET display_name = ${OWNER_NAME} WHERE id = ${w.ownerId}::uuid`,
  );
  const [home] = await rows<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const orgId = String(home?.org_id);
  await db.execute(sql`UPDATE projects SET slug = ${HOME} WHERE id = ${w.projectId}::uuid`);
  const feId = (await createTestProject(w.ownerId, { orgId })).id;
  await db.execute(sql`UPDATE projects SET slug = ${FE} WHERE id = ${feId}::uuid`);
  await addProjectMember(feId, w.ownerId, 'owner');
  // a project of another organization, which the agent does not follow
  const outsideId = (await createTestProject(w.ownerId)).id;
  await db.execute(sql`UPDATE projects SET slug = ${OUTSIDE} WHERE id = ${outsideId}::uuid`);

  const { askQuestion } = await import('../../src/questions/index.js');
  // the followed project: one issue parked on a decision only the owner makes, one at work
  const parked = await createTestIssue(feId, w.ownerId, 21, {
    status: 'needs_info',
    waitingKind: 'needs_decision',
    createdAt: new Date(),
  });
  await askQuestion({
    id: randomUUID(),
    projectId: feId,
    issueId: parked.id,
    askedBy: w.ownerId,
    prompt: PROMPT,
    blockerKind: 'human',
    answer: { shape: 'choice', options: OPTIONS, recommendedOptionId: 'short' },
  });
  await createTestIssue(feId, w.ownerId, 22, { status: 'in_progress', createdAt: new Date() });
  // the home project: an issue parked on a file the owner supplies, asked in words
  const file = await createTestIssue(w.projectId, w.ownerId, 31, {
    status: 'needs_info',
    waitingKind: 'needs_resource',
    createdAt: new Date(),
  });
  await askQuestion({
    id: randomUUID(),
    projectId: w.projectId,
    issueId: file.id,
    askedBy: w.ownerId,
    prompt: 'Send the workspace logo the sign-in page should show.',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the logo file, as an SVG' },
  });
  await w.bindTarget({
    rids: [chat.rid],
    agent: {
      product: 'Agenfold, the agent workspace',
      readers: 'users',
      grants: { abilities: ['read_checkout', 'file_items'] },
      projects: [FE],
      checks: [{ ...CHECK, rid: chat.rid }],
    },
  });
}, 120_000);

afterAll(() => w.stop());

describe('ISS-877: a channel agent reads what a parked issue waits on, and from whom', () => {
  it('reads the open question, its options and the owner who owes it, in plain words', async () => {
    const out = await readAll('2026-11-03');
    const [row, ...others] = issuesOf(out.feParked);
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      key: expect.stringMatching(/-21$/),
      status: 'needs_info',
      waiting: {
        who: OWNER_NAME,
        owes: 'make a decision',
        questions: [
          {
            id: expect.any(String),
            asks: PROMPT,
            options: [
              { option: 'short', says: 'The short tour', recommended: true },
              { option: 'full', says: 'The full tour', recommended: false },
            ],
            needed: null,
          },
        ],
      },
    });
    // what people read carries no status or kind code: the agent says it in its own words
    const words = JSON.stringify(row?.waiting);
    for (const code of ['needs_info', 'needs_decision', 'blocker', 'human', 'writer']) {
      expect(words, code).not.toContain(code);
    }

    // a file owed is named as the asker asked it, and what would settle it
    const owed = issuesOf(out.home).find((r) => r.key.endsWith('-31'));
    expect(owed?.waiting).toMatchObject({
      who: OWNER_NAME,
      owes: 'supply what it asks for',
      questions: [
        {
          asks: 'Send the workspace logo the sign-in page should show.',
          options: [],
          needed: 'the logo file, as an SVG',
        },
      ],
    });
  });

  it('reads every issue of a followed project, and only a waiting one carries what it waits on', async () => {
    const out = await readAll('2026-11-04');
    expect(out.fe).toMatchObject({ project: FE, total: 2 });
    const byKey = new Map(issuesOf(out.fe).map((r) => [r.key.split('-').pop(), r]));
    expect(byKey.get('21')?.waiting).toBeDefined();
    expect(byKey.get('22')).toMatchObject({ status: 'in_progress' });
    expect(byKey.get('22')).not.toHaveProperty('waiting');
  });

  it('refuses a project the agent does not follow', async () => {
    const out = await readAll('2026-11-05');
    expect(refusalCodes(out.outside ?? {}), JSON.stringify(out.outside)).toContain(
      'OPS_OUT_OF_SCOPE',
    );
    expect(JSON.stringify(out.outside)).toContain(`follows ${HOME}, ${FE}`);
  });

  it('names the read in the tool description and the brief', async () => {
    const { forgeSupportTool } = await import('../../src/support/tool.js');
    const tool = forgeSupportTool({} as Parameters<typeof forgeSupportTool>[0]);
    expect(tool.description).toContain("a parked issue's `waiting` says who owes what");
    // the brief the session was opened with points at it, one clause and no more
    const briefed = w.box.turns.map((t) => t.text).join('\n');
    expect(briefed).toContain(
      "support.issues (a parked issue's `waiting`: who owes it, the open question and its options)",
    );
  });
});
