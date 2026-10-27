// @direct-test-of packages/core/src/ecosystem/builder-trigger.ts
// @direct-test-of packages/core/src/ecosystem/source-push.ts
// @direct-test-of packages/core/src/ecosystem/builder-supersede.ts
// @direct-test-of packages/core/src/ecosystem/link-routes.ts
// @direct-test-of packages/core/src/ecosystem/link-service.ts

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { projectHead } from '../../src/ecosystem/builder-head.js';
import { logger } from '../../src/lib/logger.js';
import { consumerOf } from '../../src/outbox/consumers.js';
import {
  type ChannelWorld,
  ok,
  openChannelWorld,
  type Reply,
  speaker,
} from '../helpers/channel-world.js';
import { closeWorld, type Doc } from '../helpers/ecosystem-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// ISS-597 (REQ-73 BC-5): a push opens a builder run only on the branch the project builds from,
// naming that ref; and the project's own master replaces a run that cannot finish truly through a
// project route, refused by name where the act is outside the project's authority.

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

type ProjectKey = 'forge' | 'plugin' | 'store';
const runsOf = (p: ProjectKey) => `/api/projects/${w.project[p]}/builder-runs`;
const masterOf = { forge: 'masterForge', plugin: 'masterPlugin', store: 'store' } as const;

async function runsList(p: ProjectKey): Promise<Doc[]> {
  return ok(await say(masterOf[p], 'GET', runsOf(p))).runs;
}

async function openRun(p: ProjectKey): Promise<Doc | undefined> {
  return (await runsList(p)).find((r) =>
    r.document.steps.some((s: Doc) => s.status === 'pending' || s.status === 'running'),
  );
}

/** Ends the project's open run as its master would, every step skipped, so a push may open the next. */
async function finishOpenRun(p: ProjectKey): Promise<void> {
  await finishedAnswer(p);
}

/** The answer to the write that finishes the project's open run; null where none is open. */
async function finishedAnswer(p: ProjectKey): Promise<Doc | null> {
  const open = await openRun(p);
  if (!open) return null;
  const document = structuredClone(open.document);
  for (const k of ['id', 'createdAt', 'updatedAt']) delete document[k];
  document.steps = document.steps.map((s: Doc) => ({
    name: s.name,
    status: 'skipped',
    detail: 'closed by the test',
  }));
  return ok(
    await say(masterOf[p], 'PUT', `${runsOf(p)}/${open.document.id}`, {
      baseRevision: open.revision,
      document,
    }),
  );
}

const COMMIT = (n: number) => n.toString(16).padStart(40, 'd');

/** A source host's push, delivered to the ecosystem's consumer as the outbox delivers it. */
async function push(p: ProjectKey, branch: string | null, commit: string): Promise<void> {
  const consumer = consumerOf('source.pushed', 'ecosystem-builder');
  if (!consumer) throw new Error('no source.pushed consumer named ecosystem-builder is registered');
  // `defaultBranch` is what a GitHub delivery reported as the HOST's default branch before ISS-597;
  // it is sent so the old reading of it is planted, and nothing may read it now
  await consumer.handle(
    {
      projectId: w.project[p],
      bindingId: '00000000-0000-4000-8000-000000000001',
      branch,
      commit,
      defaultBranch: 'main',
    } as never,
    {
      inbox: (write: (tx: unknown) => Promise<unknown>) => db.transaction(write as never),
    } as never,
  );
}

const codes = (r: Reply): string[] => (r.json?.error?.refusals ?? []).map((x: Doc) => x.code);

describe('a push opens a builder run only on the branch the project builds from (c1)', () => {
  beforeAll(async () => {
    for (const p of ['forge', 'plugin'] as const) {
      await seedProjectDocument(w.project[p], w.user.platform, {
        environments: {},
        defaultBranch: 'dev',
      });
      await finishOpenRun(p);
    }
    await finishOpenRun('store');
  });

  it("opens nothing for a push to the host's default branch when the project builds dev", async () => {
    const before = (await runsList('forge')).length;
    await push('forge', 'main', COMMIT(1));
    await push('forge', 'feature/x', COMMIT(2));
    expect(await openRun('forge')).toBeUndefined();
    expect((await runsList('forge')).length).toBe(before);
  });

  it('opens one run for a push to the build branch, its trigger naming that ref', async () => {
    await push('forge', 'dev', COMMIT(3));
    const open = await openRun('forge');
    expect(open?.document.trigger).toMatchObject({
      kind: 'push',
      sha: COMMIT(3),
      head: { ref: 'refs/heads/dev', via: 'source-host' },
    });
  });

  it('refuses by name a push naming no branch, or to a project declaring no build branch', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const before = (await runsList('plugin')).length;
    await push('plugin', null, COMMIT(4));
    expect((await runsList('plugin')).length).toBe(before);
    const storeBefore = (await runsList('store')).length;
    await push('store', 'main', COMMIT(5));
    expect((await runsList('store')).length).toBe(storeBefore);
    const said = warn.mock.calls.map((c) => JSON.stringify(c));
    expect(said.filter((s) => s.includes('BUILDER_RUN_PUSH_UNATTRIBUTED'))).toHaveLength(2);
    expect(said.some((s) => s.includes(w.project.store) && s.includes('build branch'))).toBe(true);
    warn.mockRestore();
  });
});

describe("the project's master replaces an invalid run through its own project (c2, c3)", () => {
  let run: Doc;
  const supersede = (who: Parameters<typeof say>[0], p: ProjectKey, id: string, body?: unknown) =>
    say(who, 'POST', `${runsOf(p)}/${id}/supersede`, body);

  beforeAll(async () => {
    await push('plugin', 'dev', COMMIT(6));
    const open = await openRun('plugin');
    if (!open) throw new Error('the push to plugin@dev opened no run');
    run = open;
  });

  it('refuses a caller outside the project by name, naming the project and why, and leaves the run as it was', async () => {
    const reason = { reason: 'the run reads a branch this project does not build' };

    const fenced = await supersede('masterForge', 'plugin', run.document.id, reason);
    expect(fenced.status, JSON.stringify(fenced.json)).toBe(403);
    // the PAT door refuses a token fenced to another project before any route reads the run
    expect(codes(fenced)).toEqual(['PAT_PROJECT_OUTSIDE_FENCE']);
    expect(fenced.json.detail).toContain(w.project.plugin);
    expect(fenced.json.detail).toContain('which it does not reach');

    const viewer = await supersede('viewer', 'plugin', run.document.id, reason);
    expect(viewer.status, JSON.stringify(viewer.json)).toBe(403);
    expect(codes(viewer)).toEqual(['PERMISSION_FORBIDDEN']);
    expect(viewer.json.detail).toContain(w.project.plugin);

    const foreign = await supersede('masterForge', 'forge', run.document.id, reason);
    expect(foreign.status, JSON.stringify(foreign.json)).toBe(404);
    expect(codes(foreign)).toEqual(['BUILDER_RUN_NOT_IN_PROJECT']);
    expect(foreign.json.detail).toContain('forge');

    const unsaid = await supersede('masterPlugin', 'plugin', run.document.id, {});
    expect(codes(unsaid)).toEqual(['BUILDER_RUN_SUPERSEDE_WITHOUT_REASON']);

    const after = ok(await say('masterPlugin', 'GET', `${runsOf('plugin')}/${run.document.id}`));
    expect(after.revision).toBe(run.revision);
    expect(after.document.steps).toEqual(run.document.steps);
    expect(after.document.supersededBy).toBeUndefined();
  });

  it("supersedes the run for the project's fenced master, holding no outside credential", async () => {
    const done = ok(
      await supersede('masterPlugin', 'plugin', run.document.id, {
        reason: 'the run reads a branch this project does not build',
      }),
    );
    expect(done.superseded.document.supersededBy).toMatchObject({
      run: done.opened.document.id,
      reason: 'the run reads a branch this project does not build',
    });
    expect(done.opened.document).toMatchObject({
      project: w.project.plugin,
      trigger: { kind: 'manual' },
    });
    const open = await openRun('plugin');
    expect(open?.document.id).toBe(done.opened.document.id);
  });

  it('refuses a run already superseded by name, opening nothing', async () => {
    const again = await supersede('masterPlugin', 'plugin', run.document.id, {
      reason: 'again',
    });
    expect(codes(again)).toEqual(['BUILDER_RUN_NOT_OPEN']);
    expect((await runsList('plugin')).filter((r) => !r.document.supersededBy)).toHaveLength(
      (await runsList('plugin')).length - 1,
    );
  });
});

// adminhub-api, 2026-10-26: the push to release/stg at cf94a1e6 opened builder run 2e1e876c, and the
// five pushes that landed while it was open (89b3ce31 .. e47af8c8) opened nothing, nor did the run's
// finish: the branch head stayed unmapped with nothing owed.
describe('pushes that land while a run is open are mapped once, at the head, when it finishes (c4)', () => {
  const headAt = (sha: string) =>
    vi.spyOn(projectHead, 'read').mockResolvedValue({
      ok: true,
      value: { sha, ref: 'refs/heads/dev', readAt: new Date().toISOString(), via: 'source-host' },
    });

  beforeAll(async () => {
    await seedProjectDocument(w.project.forge, w.user.platform, {
      environments: {},
      defaultBranch: 'dev',
    });
  });

  /** Finishes whatever run is open at a head that has not moved, so nothing follows it. */
  async function finishWhereItMapped(p: ProjectKey): Promise<void> {
    const open = await openRun(p);
    if (!open) return;
    const spy = headAt(open.document.trigger.sha);
    await finishOpenRun(p);
    spy.mockRestore();
  }

  it('opens exactly one run at the latest head, however many pushes landed meanwhile', async () => {
    await finishWhereItMapped('forge');
    expect(await openRun('forge')).toBeUndefined();
    await push('forge', 'dev', COMMIT(20));
    const first = await openRun('forge');
    expect(first?.document.trigger.sha).toBe(COMMIT(20));
    const before = (await runsList('forge')).length;
    for (const n of [21, 22, 23]) await push('forge', 'dev', COMMIT(n));
    expect((await runsList('forge')).length).toBe(before);

    const spy = headAt(COMMIT(23));
    const answer = await finishedAnswer('forge');
    spy.mockRestore();

    expect(answer?.report?.next).toMatchObject({ at: COMMIT(23), mapped: COMMIT(20) });
    const runs = await runsList('forge');
    expect(runs.length).toBe(before + 1);
    const next = await openRun('forge');
    expect(next?.document.id).toBe(answer?.report?.next?.opened);
    expect(next?.document.trigger).toMatchObject({
      kind: 'push',
      sha: COMMIT(23),
      head: { ref: 'refs/heads/dev', via: 'source-host' },
    });
  });

  it('opens nothing when the run finishes at the head it mapped', async () => {
    const spy = headAt(COMMIT(23));
    const before = (await runsList('forge')).length;
    const answer = await finishedAnswer('forge');
    spy.mockRestore();

    expect(answer?.report?.next).toBeUndefined();
    expect((await runsList('forge')).length).toBe(before);
    expect(await openRun('forge')).toBeUndefined();
  });

  it('says in the answer why none opened where the head cannot be read, and the next push opens it', async () => {
    await push('forge', 'dev', COMMIT(30));
    await push('forge', 'dev', COMMIT(31));
    const spy = vi
      .spyOn(projectHead, 'read')
      .mockResolvedValue({ ok: false, why: 'the binding answered 503' });
    const answer = await finishedAnswer('forge');
    spy.mockRestore();

    expect(answer?.report?.next?.opened).toBeNull();
    expect(answer?.report?.next?.why).toContain('the binding answered 503');
    expect(await openRun('forge')).toBeUndefined();
    await push('forge', 'dev', COMMIT(32));
    expect((await openRun('forge'))?.document.trigger.sha).toBe(COMMIT(32));
  });
});
