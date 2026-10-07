/**
 * A release says what it changes (`release-batch/landing-surfaces.ts`): each landing names its
 * artifacts by surface, the release read groups them, flags a data removal, and keeps a design
 * revision apart as shipping nothing — through the mark route and the release read, against real
 * Postgres. A surface outside the closed set is refused by name.
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import { releaseWorld, seedProjectDocument } from '../helpers/release-world.js';

const NOTE = { section: 'Added', userFacing: 'A change' };

let projectId: string;
let ownerId: string;
let token: string;

const fx = releaseWorld(() => ({ projectId, ownerId }));

const FORGE_CORE_SURFACES = JSON.parse(
  readFileSync(new URL('../fixtures/forge-core-surfaces.json', import.meta.url), 'utf8'),
);

async function declare(
  source: Parameters<typeof seedProjectDocument>[2]['source'],
  surfaces?: unknown,
) {
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      live: { tier: 'production', deployment: { mode: 'external' } },
    },
    ...(source ? { source } : {}),
    ...(surfaces ? { extra: { surfaces } as never } : {}),
  });
}

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
});

const mark = (issueId: string, body: unknown) =>
  api(token, 'POST', `/api/issues/${issueId}/merge`, body);

const markOk = async (issueId: string, body: unknown) => {
  const r = await mark(issueId, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

const releaseOf = async (version: string) => {
  const r = await api(token, 'GET', `/api/projects/${projectId}/releases/${version}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.release as {
    issues: Array<{
      key: string;
      surfaces: string[];
      unclassified: boolean;
      landing: { kind: string; why?: string };
    }>;
    changes: {
      surfaces: Array<{
        surface: string;
        count: number;
        shipsNothing: boolean;
        issues: string[];
        artifacts: Array<{ ref: string; change: string; issues: string[] }>;
      }>;
      risks: Array<{ risk: string; surface: string; ref: string; issues: string[] }>;
      unclassified: Array<{ key: string; why: string }>;
      boxRead: string[];
      shipsNothing: boolean;
    };
  };
};

const mergedArtifacts = async (issueId: string) => {
  const [row] = [
    ...(await db.execute(sql`SELECT merged_artifacts FROM issues WHERE id = ${issueId}`)),
  ] as Array<{ merged_artifacts: unknown }>;
  return row?.merged_artifacts ?? null;
};

describe('outside git, a landing names what it changed', () => {
  beforeEach(() => declare({ type: 'none' }));

  it('reads a release of one ui, one data-removed and one design issue as three surfaces, the data removal flagged and design shipping nothing', async () => {
    const ui = await fx.insertIssue('awaiting_release', NOTE, false);
    const data = await fx.insertIssue('awaiting_release', NOTE, false);
    const design = await fx.insertIssue('awaiting_release', NOTE, false);
    const prose = await fx.insertIssue('awaiting_release', NOTE, false);

    const answered = await markOk(ui, {
      landing: 'https://hop.example.test/cases',
      artifacts: [{ surface: 'ui', ref: 'screen:/cases', change: 'added' }],
    });
    expect(answered.artifacts).toEqual([{ surface: 'ui', ref: 'screen:/cases', change: 'added' }]);
    await markOk(data, {
      landing: 'autoflow:hop-attention-sweep@v3',
      artifacts: [{ surface: 'data', ref: 'table:hop_attention', change: 'removed' }],
    });
    await markOk(design, {
      landing: 'forge-workflow:discharge-post-care@rev7 (b2eb2792), approved by the owner',
    });
    await markOk(prose, { landing: 'https://hop.example.test/somewhere' });
    expect(await mergedArtifacts(design)).toEqual([
      { surface: 'design', ref: 'discharge-post-care@rev7', change: 'changed' },
    ]);
    expect(await mergedArtifacts(prose)).toBeNull();

    const release = await releaseOf('0.1.0');
    expect(release.changes.surfaces.map((s) => s.surface)).toEqual(['ui', 'data', 'design']);
    expect(release.changes.surfaces.find((s) => s.surface === 'design')).toMatchObject({
      shipsNothing: true,
      count: 1,
      artifacts: [{ ref: 'discharge-post-care@rev7', change: 'changed', issues: ['ISS-3'] }],
    });
    expect(release.changes.surfaces.find((s) => s.surface === 'ui')).toMatchObject({
      shipsNothing: false,
      issues: ['ISS-1'],
    });
    expect(release.changes.risks).toEqual([
      expect.objectContaining({
        risk: 'data_removed',
        surface: 'data',
        ref: 'table:hop_attention',
        issues: ['ISS-2'],
      }),
    ]);
    expect(release.changes.unclassified).toEqual([
      { key: 'ISS-4', why: expect.stringMatching(/names no artifact/), paths: [] },
    ]);
    expect(release.changes.shipsNothing).toBe(false);
    expect(Object.fromEntries(release.issues.map((i) => [i.key, i.surfaces]))).toEqual({
      'ISS-1': ['ui'],
      'ISS-2': ['data'],
      'ISS-3': ['design'],
      'ISS-4': [],
    });
    expect(release.issues.filter((i) => i.unclassified).map((i) => i.key)).toEqual(['ISS-4']);
  });

  it('reads a release of design revisions alone as shipping nothing', async () => {
    const design = await fx.insertIssue('awaiting_release', NOTE, false);
    await markOk(design, { landing: 'workflow design `intake` revision 2, approved' });
    const release = await releaseOf('0.1.0');
    expect(release.changes).toMatchObject({ shipsNothing: true, risks: [], unclassified: [] });
  });

  it('refuses a surface outside the closed set by name, and marks nothing', async () => {
    const issue = await fx.insertIssue('awaiting_release', NOTE, false);
    const r = await mark(issue, {
      landing: 'https://hop.example.test/cases',
      artifacts: [{ surface: 'frontend', ref: 'screen:/cases', change: 'added' }],
    });
    expect(r.status).toBe(400);
    const text = JSON.stringify(r.body);
    expect(text).toContain('frontend');
    expect(text).toContain('is not a landing surface');
    expect(text).toContain('/artifacts/0/surface');
    const [row] = [
      ...(await db.execute(sql`SELECT merged_at FROM issues WHERE id = ${issue}`)),
    ] as Array<{ merged_at: unknown }>;
    expect(row?.merged_at).toBeNull();
  });

  it('refuses a deployed artifact beside a design revision landing, by name', async () => {
    const issue = await fx.insertIssue('awaiting_release', NOTE, false);
    const r = await mark(issue, {
      landing: 'forge-workflow:intake@rev2',
      artifacts: [{ surface: 'ui', ref: 'screen:/intake', change: 'changed' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(JSON.stringify(r.body)).toContain('ARTIFACTS_NOT_DESIGN');
  });
});

describe('on git, artifacts come from the commit, never by hand', () => {
  beforeEach(() =>
    declare({
      type: 'git',
      git: {
        repository: 'github.com/acme/test-project',
        defaultBranch: 'main',
        branches: ['main'],
      },
    }),
  );

  it('refuses artifacts sent with the mark, by name, and reads a claim with no observed commit as unclassified', async () => {
    const issue = await fx.insertIssue('awaiting_release', NOTE, false);
    const refused = await mark(issue, {
      target: 'main',
      artifacts: [{ surface: 'ui', ref: 'packages/web-v2/x.tsx', change: 'changed' }],
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('ARTIFACTS_NOT_THIS_SHAPE');

    await markOk(issue, { target: 'main' });
    const release = await releaseOf('0.1.0');
    expect(release.issues[0]?.landing).toMatchObject({
      kind: 'unclassified',
      why: expect.stringMatching(/no commit Forge observed/),
    });
  });
});

const SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';
const BOX_PATHS = {
  commit: SHA,
  changes: [
    {
      path: 'packages/web-v2/src/features/releases/components/release-changes.tsx',
      change: 'added',
    },
    { path: 'packages/core/drizzle/migrations/0433_a.sql', change: 'added' },
    { path: 'packages/core/drizzle/migrations/0101_old.sql', change: 'removed' },
    { path: 'docs/modules/issues/merge-mark.md', change: 'changed' },
  ],
};

describe('on git with no source host, the paths a box read are classified and labelled box-read', () => {
  beforeEach(() =>
    declare(
      {
        type: 'git',
        git: { repository: 'github.com/SidCorp-co/forge', defaultBranch: 'dev', branches: ['dev'] },
      },
      FORGE_CORE_SURFACES,
    ),
  );

  it("records the box's paths with the mark and reads them by the project's map as box-read", async () => {
    const issue = await fx.insertIssue('awaiting_release', NOTE, false);
    await markOk(issue, { target: 'dev', commit: SHA.slice(0, 12), changedPaths: BOX_PATHS });
    const [row] = [
      ...(await db.execute(sql`SELECT merged_paths FROM issues WHERE id = ${issue}`)),
    ] as Array<{ merged_paths: { read: string; commit: string } | null }>;
    expect(row?.merged_paths).toMatchObject({ read: 'box', commit: SHA });

    const release = await releaseOf('0.1.0');
    expect(release.issues[0]?.landing).toMatchObject({ kind: 'named', source: 'box' });
    expect(release.issues[0]?.surfaces).toEqual(['ui', 'data']);
    expect(release.changes.boxRead).toEqual([release.issues[0]?.key]);
    expect(release.changes.risks).toEqual([
      expect.objectContaining({
        risk: 'data_removed',
        ref: 'packages/core/drizzle/migrations/0101_old.sql',
      }),
    ]);

    const again = await mark(issue, { target: 'dev', commit: SHA, changedPaths: BOX_PATHS });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const other = await mark(issue, {
      target: 'dev',
      commit: 'a'.repeat(40),
      changedPaths: { ...BOX_PATHS, commit: 'a'.repeat(40) },
    });
    expect(other.status, JSON.stringify(other.body)).toBe(422);
    expect(JSON.stringify(other.body)).toContain('MARK_ALREADY_STANDS');
  });

  it('refuses paths read at another commit than the mark names, by name, and marks nothing', async () => {
    const issue = await fx.insertIssue('awaiting_release', NOTE, false);
    const r = await mark(issue, { target: 'dev', commit: 'a'.repeat(40), changedPaths: BOX_PATHS });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(JSON.stringify(r.body)).toContain('CHANGED_PATHS_UNMATCHED');
    const [row] = [
      ...(await db.execute(sql`SELECT merged_at FROM issues WHERE id = ${issue}`)),
    ] as Array<{ merged_at: unknown }>;
    expect(row?.merged_at).toBeNull();
  });
});

describe('outside git, changed paths are not a landing', () => {
  beforeEach(() => declare({ type: 'none' }));

  it('refuses changedPaths by name', async () => {
    const issue = await fx.insertIssue('awaiting_release', NOTE, false);
    const r = await mark(issue, {
      landing: 'https://hop.example.test/cases',
      commit: SHA,
      changedPaths: BOX_PATHS,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(JSON.stringify(r.body)).toContain('CHANGED_PATHS_NOT_THIS_SHAPE');
  });
});
