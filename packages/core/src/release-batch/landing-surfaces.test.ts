import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SourceHost } from '../integrations/source-host/index.js';
import type { ProjectDocument } from '../project-config/index.js';
import { surfacesSchema } from '../project-config/surfaces-schema.js';
import {
  classifyChanges,
  readLandingReadings,
  releaseChangesOf,
  surfaceMapOf,
} from './landing-surfaces.js';

/** forge-core's own map, the documented example a project carries in its document's `surfaces`. */
const FORGE_CORE_SURFACES = surfacesSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../tests/fixtures/forge-core-surfaces.json', import.meta.url), 'utf8'),
  ),
);

const gitDocument = (repository: string, surfaces?: unknown) =>
  ({
    source: { type: 'git', git: { repository, defaultBranch: 'main', branches: ['main'] } },
    ...(surfaces ? { surfaces } : {}),
  }) as unknown as ProjectDocument;

const CHANGES = [
  { path: 'packages/web-v2/src/features/releases/components/release-changes.tsx', change: 'added' },
  { path: 'packages/core/src/issues/merge-routes.ts', change: 'changed' },
  { path: 'packages/core/src/release-batch/landing-surfaces.ts', change: 'added' },
  { path: 'packages/core/drizzle/migrations/0433_x.sql', change: 'added' },
  { path: 'packages/runner/crates/forge-runner/src/main.rs', change: 'changed' },
  { path: '.forge/conformance.json', change: 'changed' },
  { path: 'packages/core/src/release-batch/landing-surfaces.test.ts', change: 'added' },
  { path: 'docs/modules/issues/merge-mark.md', change: 'changed' },
  { path: 'LICENSE', change: 'changed' },
] as const;

function hostWith(fullName: string, changes: readonly { path: string; change: string }[]) {
  return {
    fullName,
    commitFiles: async () => ({ files: changes.map((c) => c.path), changes }),
  } as unknown as SourceHost;
}

describe("a git landing's surfaces, read from its changed paths", () => {
  it("sorts forge-core's own tree by the shipped map, drops what ships nothing, and leaves the rest unmapped", () => {
    const { artifacts, unmapped } = classifyChanges(FORGE_CORE_SURFACES, CHANGES);
    expect(artifacts.map((a) => [a.surface, a.change])).toEqual([
      ['ui', 'added'],
      ['api', 'changed'],
      ['logic', 'added'],
      ['data', 'added'],
      ['runner', 'changed'],
      ['config', 'changed'],
    ]);
    expect(unmapped).toEqual(['LICENSE']);
  });

  it('reads the map from the project document alone: no repository name brings one', () => {
    expect(surfaceMapOf(gitDocument('github.com/SidCorp-co/forge-core'))).toBeNull();
    expect(surfaceMapOf(gitDocument('github.com/SidCorp-co/forge', FORGE_CORE_SURFACES))).toEqual(
      FORGE_CORE_SURFACES,
    );
    expect(surfaceMapOf(null)).toBeNull();
  });

  it('reads an observed commit through the host into named artifacts, and an unmapped project as unclassified paths', async () => {
    const facts = [
      {
        id: 'a',
        marked: true,
        landing: null,
        artifacts: null,
        commitSha: 'a'.repeat(40),
        readPaths: null,
      },
    ];
    const core = await readLandingReadings('p', facts, {
      document: async () => gitDocument('github.com/SidCorp-co/forge-core', FORGE_CORE_SURFACES),
      host: async () => hostWith('SidCorp-co/forge-core', CHANGES),
    });
    expect(core.get('a')).toMatchObject({
      kind: 'named',
      unmappedPaths: ['LICENSE'],
      source: 'host',
    });

    const other = await readLandingReadings('p', facts, {
      document: async () => gitDocument('github.com/acme/shop'),
      host: async () => hostWith('acme/shop', CHANGES),
    });
    expect(other.get('a')).toMatchObject({
      kind: 'unclassified',
      why: expect.stringMatching(/declares no `surfaces`/),
      paths: expect.arrayContaining(['LICENSE', 'packages/core/src/issues/merge-routes.ts']),
    });
  });

  it('reads the commit of a git issue whose design approval named a revision, and keeps both', async () => {
    const facts = [
      {
        id: 'd',
        marked: true,
        landing: null,
        artifacts: [{ surface: 'design' as const, ref: 'intake@rev2', change: 'changed' as const }],
        commitSha: 'd'.repeat(40),
        readPaths: null,
      },
    ];
    const readings = await readLandingReadings('p', facts, {
      document: async () => gitDocument('github.com/SidCorp-co/forge-core', FORGE_CORE_SURFACES),
      host: async () =>
        hostWith('SidCorp-co/forge-core#design', [
          { path: 'packages/core/src/issues/merge-routes.ts', change: 'changed' },
        ]),
    });
    const reading = readings.get('d');
    expect(reading).toMatchObject({ kind: 'named', unread: null });
    const changes = releaseChangesOf([{ key: 'ISS-9', reading: reading as never }]);
    expect(changes.surfaces.map((s) => s.surface)).toEqual(['api', 'design']);
    expect(changes.shipsNothing).toBe(false);

    const unread = await readLandingReadings('p', facts, {
      document: async () => gitDocument('github.com/SidCorp-co/forge-core', FORGE_CORE_SURFACES),
      host: async () =>
        ({
          fullName: 'SidCorp-co/forge-core#unread',
          commitFiles: async () => ({ why: '300 or more files differ' }),
        }) as unknown as SourceHost,
    });
    expect(unread.get('d')).toMatchObject({ kind: 'named', unread: '300 or more files differ' });
    const partly = releaseChangesOf([{ key: 'ISS-9', reading: unread.get('d') as never }]);
    expect(partly.shipsNothing).toBe(false);
    expect(partly.unclassified).toEqual([
      { key: 'ISS-9', why: '300 or more files differ', paths: [] },
    ]);
  });

  it('never reads a git issue whose mark holds only its design revision as shipping nothing (FB-105)', async () => {
    // dev.113, 2026-10-07: ISS-350 changed code, but a design approval stamped it first and the
    // commit the run claimed afterwards reached no column, so the release read "ships nothing"
    const facts = [
      {
        id: 'e',
        marked: true,
        landing: null,
        artifacts: [
          { surface: 'design' as const, ref: 'issue-delivery@rev18', change: 'changed' as const },
        ],
        commitSha: null,
        readPaths: null,
      },
    ];
    const readings = await readLandingReadings('p', facts, {
      document: async () => gitDocument('github.com/SidCorp-co/forge-core', FORGE_CORE_SURFACES),
    });
    const reading = readings.get('e');
    expect(reading).toMatchObject({ kind: 'named', source: 'mark' });
    expect((reading as { unread: string | null }).unread).toMatch(
      /no commit Forge observed and no paths a box read/,
    );
    const changes = releaseChangesOf([{ key: 'ISS-350', reading: reading as never }]);
    expect(changes.shipsNothing).toBe(false);
    expect(changes.unclassified.map((u) => u.key)).toEqual(['ISS-350']);

    const outside = await readLandingReadings(
      'p',
      [{ ...facts[0], landing: 'forge-workflow:issue-delivery@rev18' } as (typeof facts)[number]],
      { document: async () => ({ source: { type: 'none' } }) as unknown as ProjectDocument },
    );
    expect(outside.get('e'), 'outside git the revision is the whole landing').toMatchObject({
      kind: 'named',
      unread: null,
    });
  });

  it('classifies paths a box read from its checkout, with no source host at all, and says the box read them', async () => {
    const facts = [
      {
        id: 'b',
        marked: true,
        landing: null,
        artifacts: null,
        commitSha: null,
        readPaths: { commit: 'b'.repeat(40), read: 'box' as const, changes: [...CHANGES] },
      },
    ];
    const readings = await readLandingReadings('p', facts, {
      document: async () => gitDocument('github.com/SidCorp-co/forge', FORGE_CORE_SURFACES),
      host: async () => {
        throw new Error('a box-read landing asked the source host');
      },
    });
    const reading = readings.get('b');
    expect(reading).toMatchObject({ kind: 'named', source: 'box', unmappedPaths: ['LICENSE'] });
    const changes = releaseChangesOf([{ key: 'ISS-5', reading: reading as never }]);
    expect(changes.boxRead).toEqual(['ISS-5']);
    expect(changes.surfaces.map((s) => s.surface)).toEqual([
      'ui',
      'api',
      'logic',
      'data',
      'config',
      'runner',
    ]);
  });

  it('refuses a map naming a surface no path can be, by name', () => {
    const parsed = surfacesSchema.safeParse({
      rules: [{ surface: 'design', paths: ['docs/**'] }],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('cannot be mapped from a path');
  });
});

describe('what a release changes together', () => {
  it('flags a changed table and a removed route, never an added one', () => {
    const changes = releaseChangesOf([
      {
        key: 'ISS-1',
        reading: {
          kind: 'named',
          unmappedPaths: [],
          unread: null,
          source: 'mark',
          artifacts: [
            { surface: 'data', ref: 'table:cases', change: 'changed' },
            { surface: 'api', ref: 'DELETE /cases/:id', change: 'removed' },
            { surface: 'api', ref: 'POST /cases', change: 'added' },
          ],
        },
      },
    ]);
    expect(changes.risks.map((r) => r.risk)).toEqual(['api_removed', 'data_changed']);
    expect(changes.unclassified).toEqual([]);
    expect(changes.surfaces.map((s) => [s.surface, s.count])).toEqual([
      ['api', 2],
      ['data', 1],
    ]);
  });

  it('lists paths no rule claims beside a classified landing, so the summary never reads complete', () => {
    const changes = releaseChangesOf([
      {
        key: 'ISS-2',
        reading: {
          kind: 'named',
          unmappedPaths: ['db/schema.sql'],
          unread: null,
          source: 'host',
          artifacts: [{ surface: 'ui', ref: 'web/app.tsx', change: 'changed' }],
        },
      },
    ]);
    expect(changes.surfaces.map((s) => s.surface)).toEqual(['ui']);
    expect(changes.unclassified).toEqual([
      { key: 'ISS-2', why: expect.stringMatching(/claimed by no rule/), paths: ['db/schema.sql'] },
    ]);
  });
});
