/**
 * Every release cut is named (REQ-40 BC-14). Releases cut unattended — the sweep's cut as an issue
 * enters the release gate, the scheduled cut — never had a name written: 256 of them on dev opened
 * on a bare version. Now a cut nobody named is named by the assistant through the outbox
 * (`release.cut`, emitted in the cut's own transaction), from its changes' lines for users and the
 * requirements it carries; a draft that cannot be written is said on the page with why, and the
 * master is still owed the name; a name a person wrote is never replaced. Against real Postgres,
 * with the gateway model faked at the provider seam behind `completeOnce`.
 *
 * @direct-test-of packages/core/src/release-page/naming-refresh.ts
 * @direct-test-of packages/core/src/release-page/naming-draft.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { register } from '../../src/integrations/llm/registry.js';
import type { ChatMessage, ChatStreamEvent } from '../../src/integrations/llm/types.js';
import { unnamedReleases } from '../../src/release-batch/index.js';
import {
  backgroundNamingsSettled,
  backgroundRefreshesSettled,
  nameReleaseIfOwed,
} from '../../src/release-page/index.js';
import { cutWaitingRelease } from '../../src/schedules/index.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import { declareProductionDocument, releaseWorld, SKIP_NOTE } from '../helpers/release-world.js';

// Only a naming draft (its system prompt opens "You name release") is recorded and scripted; every
// other assistant a release wakes (its highlights) gets an empty answer and is not counted.
const asked: ChatMessage[][] = [];
let answers: string[] = [];
const namesARelease = (messages: readonly ChatMessage[]) =>
  messages.some((m) => typeof m.content === 'string' && m.content.startsWith('You name release'));
register('openai', () => ({
  id: 'scripted',
  defaultModel: 'scripted-model',
  async *stream(req): AsyncIterable<ChatStreamEvent> {
    const naming = namesARelease(req.messages);
    if (naming) asked.push(req.messages);
    yield { type: 'chunk', text: naming ? (answers.shift() ?? '') : '' };
    yield { type: 'usage', usage: { promptTokens: 60, completionTokens: 30 } };
    yield { type: 'done' };
  },
}));

const REMINDERS = {
  section: 'Added',
  title: 'Visit reminders',
  userFacing: 'Nurses see a reminder before each home visit.',
};
const NAMED = {
  name: 'Visit reminders',
  summary:
    'Nurses now see a reminder before each home visit. Nobody misses a visit for want of a note.',
};

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeEach(async () => {
  asked.length = 0;
  answers = [];
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
});

afterEach(async () => {
  // a page read that found its release unnamed starts a draft; none outlives its test
  await backgroundNamingsSettled();
  await backgroundRefreshesSettled();
});

const call = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function runNaming(runId: string): Promise<Record<string, unknown> | null> {
  const [row] = [
    ...(await db.execute(
      sql`SELECT metadata->'naming' AS naming FROM pipeline_runs WHERE id = ${runId}`,
    )),
  ];
  return (row as { naming: Record<string, unknown> | null }).naming;
}

async function page(version: string) {
  const r = await call('GET', `/releases/${version}/page`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as {
    header: {
      name: string | null;
      summary: string | null;
      naming: { state: string; refusals?: { code: string }[] };
    };
  };
}

/** The unattended cut the sweep makes as an issue enters the release gate (`release-sweep.ts`). */
async function autoCut(issueIds: string[]): Promise<{ runId: string; version: string }> {
  const outcome = await cutWaitingRelease({ projectId, userId: ownerId, issueIds });
  expect(outcome.status, JSON.stringify(outcome)).toBe('success');
  const [row] = [
    ...(await db.execute(
      sql`SELECT release_version FROM pipeline_runs WHERE id = ${String(outcome.runId)}`,
    )),
  ];
  return {
    runId: String(outcome.runId),
    version: (row as { release_version: string }).release_version,
  };
}

describe('a release cut with no name is named by the assistant (REQ-40 BC-14)', () => {
  it('names the auto cut through the outbox, from what its users see and nothing else', async () => {
    const roster = [await fx.insertIssue('awaiting_release', REMINDERS), await fx.insertIssue()];
    answers = [JSON.stringify(NAMED)];
    await startQueue();
    let cut: { runId: string; version: string };
    try {
      cut = await autoCut(roster);
      await settleOutbox();
    } finally {
      await closeWorld();
    }
    expect(await runNaming(cut.runId), 'the cut is named, never left null').toMatchObject({
      ...NAMED,
      by: null,
    });
    expect(asked).toHaveLength(1);
    const input = String(asked[0]?.at(-1)?.content);
    expect(input).toContain('Visit reminders: Nurses see a reminder before each home visit.');
    // a Skip note is what nobody using the product sees: never a line the name is drafted from
    expect(input).not.toMatch(/^- -$/m);
    const p = await page(cut.version);
    expect(p.header).toMatchObject({ ...NAMED, naming: { state: 'named' } });
    expect(await unnamedReleases(projectId)).toEqual([]);
  });

  it('says on the page why a refused draft was not written, and leaves the name owed to the master', async () => {
    const roster = [await fx.insertIssue('awaiting_release', REMINDERS)];
    const jargon = JSON.stringify({
      name: 'Visit reminders',
      summary: 'REQ-17 moves on as BC-29 asks. Nurses see a reminder.',
    });
    answers = [jargon, jargon];
    const cut = await autoCut(roster);
    expect(await nameReleaseIfOwed(projectId, cut.version)).toBe('refused');
    expect(asked).toHaveLength(2);
    expect(String(asked[1]?.at(-1)?.content)).toContain('RELEASE_NAMING_JARGON');
    expect(await runNaming(cut.runId)).toBeNull();
    const p = await page(cut.version);
    expect(p.header.naming.state).toBe('failed');
    // the keys are jargon, and their numbers are figures the release never states
    expect(p.header.naming.refusals?.map((r) => r.code)).toEqual([
      'RELEASE_NAMING_JARGON',
      'RELEASE_NAMING_FIGURE_UNBACKED',
      'RELEASE_NAMING_FIGURE_UNBACKED',
    ]);
    expect(await unnamedReleases(projectId)).toEqual([{ version: cut.version }]);
    // inside its retry window a refusal is held, never redrafted on every read
    expect(await nameReleaseIfOwed(projectId, cut.version)).toBe('held');
    expect(asked).toHaveLength(2);
  });

  it('refuses by name to name a release its users see nothing of, asking no model', async () => {
    const cut = await autoCut([await fx.insertIssue('awaiting_release', SKIP_NOTE)]);
    expect(await nameReleaseIfOwed(projectId, cut.version)).toBe('nothing_to_say');
    expect(asked).toHaveLength(0);
    const p = await page(cut.version);
    expect(p.header.naming.refusals?.map((r) => r.code)).toEqual(['RELEASE_NAMING_NOTHING_TO_SAY']);
  });

  it('never replaces a name a person wrote', async () => {
    const cut = await autoCut([await fx.insertIssue('awaiting_release', REMINDERS)]);
    const given = {
      name: 'Home visits',
      summary: 'Home visits come with a reminder. Nurses are told before they set out.',
    };
    expect((await call('PUT', `/releases/${cut.version}/naming`, given)).status).toBe(200);
    answers = [JSON.stringify(NAMED)];
    expect(await nameReleaseIfOwed(projectId, cut.version)).toBe('already_named');
    expect(asked).toHaveLength(0);
    expect(await runNaming(cut.runId)).toMatchObject(given);
  });

  it('names a draft once its page is read, and the cut keeps that name', async () => {
    const roster = [await fx.insertIssue('awaiting_release', REMINDERS)];
    const list = await call('GET', '/releases');
    const draft = (list.body.releases as { version: string; state: string }[]).find(
      (x) => x.state === 'draft',
    );
    const version = String(draft?.version);
    answers = [JSON.stringify(NAMED)];
    expect((await page(version)).header.naming.state).toBe('drafting');
    await backgroundNamingsSettled();
    expect((await page(version)).header).toMatchObject({ ...NAMED, naming: { state: 'named' } });
    const cut = await call('POST', '/release-batches', { issueIds: roster });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    expect(await runNaming(String(cut.body.runId))).toMatchObject({ ...NAMED, by: null });
    expect(asked).toHaveLength(1);
  });
});
