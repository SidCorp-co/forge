import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SourceHost } from '../integrations/source-host/index.js';
import type { ProjectDocument } from '../project-config/index.js';
import { surfacesSchema } from '../project-config/surfaces-schema.js';
import {
  classifyChanges,
  rangeChangesOf,
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
    const fact = {
      id: 'e',
      marked: true,
      landing: null as string | null,
      artifacts: [
        { surface: 'design' as const, ref: 'issue-delivery@rev18', change: 'changed' as const },
      ],
      commitSha: null,
      readPaths: null,
    };
    const readings = await readLandingReadings('p', [fact], {
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
      [{ ...fact, landing: 'forge-workflow:issue-delivery@rev18' }],
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

describe("a migrator's bookkeeping is never a data-shape risk", () => {
  // J9 on 0.4.0-dev.224 and dev.225: both pages warned that `migrations/meta/_journal.json changes
  // shape: rows written before it are read by the new shape`. The journal lists migrations; it holds
  // no rows.
  it('flags a changed migration but not the journal or a snapshot beside it', () => {
    const changes = releaseChangesOf([
      {
        key: 'ISS-452',
        reading: {
          kind: 'named',
          unmappedPaths: [],
          unread: null,
          source: 'box',
          artifacts: [
            { surface: 'data', ref: 'packages/core/drizzle/migrations/meta/_journal.json', change: 'changed' },
            { surface: 'data', ref: 'packages/core/drizzle/migrations/meta/0494_snapshot.json', change: 'removed' },
            { surface: 'data', ref: 'packages/core/drizzle/migrations/0490_x.sql', change: 'changed' },
          ],
        },
      },
    ]);
    expect(changes.risks.map((r) => [r.risk, r.ref])).toEqual([
      ['data_changed', 'packages/core/drizzle/migrations/0490_x.sql'],
    ]);
  });
});

describe("what a release's own commit range changes (BC-9)", () => {
  // J9 on 0.4.0-dev.225: the dev.224 developer view (range 3b5e47c..852dcfb) listed migration 0495
  // and ISS-455's intake files under What it changes. They are d729b27be, ISS-455's next round, which
  // shipped in dev.225: the page read each claimed issue's latest landing whole. It also left out
  // files the range does ship that no landing named.
  const J = 'packages/core/drizzle/migrations/meta/_journal.json';
  const M494 = 'packages/core/drizzle/migrations/0494_a_feedback_item_the_record_cannot_verify_says_why.sql';
  const M495 = 'packages/core/drizzle/migrations/0495_an_intake_draft_the_model_missed_is_tried_again.sql';
  const INTAKE = 'packages/web-v2/src/features/intake/components/intake-draft.tsx';
  const VISUAL = 'packages/web-v2/src/features/releases/components/visual-block.tsx';
  const landed = releaseChangesOf([
    {
      key: 'ISS-452',
      reading: {
        kind: 'named',
        unmappedPaths: [],
        unread: null,
        source: 'box',
        artifacts: [
          { surface: 'data', ref: M494, change: 'added' },
          { surface: 'data', ref: J, change: 'changed' },
        ],
      },
    },
    {
      key: 'ISS-455',
      reading: {
        kind: 'named',
        unmappedPaths: ['packages/core/tsconfig.json'],
        unread: null,
        source: 'box',
        artifacts: [
          { surface: 'data', ref: M495, change: 'added' },
          { surface: 'data', ref: J, change: 'changed' },
          { surface: 'ui', ref: INTAKE, change: 'changed' },
        ],
      },
    },
    {
      key: 'ISS-470',
      reading: {
        kind: 'named',
        unmappedPaths: [],
        unread: null,
        source: 'mark',
        artifacts: [{ surface: 'design', ref: 'WF-3 r2', change: 'changed' }],
      },
    },
  ]);
  const range = [
    { path: M494, change: 'added' },
    { path: J, change: 'changed' },
    { path: 'packages/core/drizzle/migrations/meta/0494_snapshot.json', change: 'added' },
    { path: VISUAL, change: 'changed' },
    { path: 'packages/core/tsconfig.json', change: 'changed' },
    { path: 'CHANGELOG.md', change: 'changed' },
    { path: 'biome.json', change: 'changed' },
  ] as const;

  it('lists only the files the range changed, never a later round its issues landed', () => {
    const out = rangeChangesOf(range, FORGE_CORE_SURFACES, landed);
    const refs = out.surfaces.flatMap((s) => s.artifacts.map((a) => a.ref));
    expect(refs).not.toContain(M495);
    expect(refs).not.toContain(INTAKE);
    expect(out.surfaces.find((s) => s.surface === 'data')?.artifacts.map((a) => [a.ref, a.issues])).toEqual([
      [M494, ['ISS-452']],
      [J, ['ISS-452', 'ISS-455']],
      ['packages/core/drizzle/migrations/meta/0494_snapshot.json', []],
    ]);
  });

  it('lists a file the range ships that no landing names, and paths no rule claims under no issue', () => {
    const out = rangeChangesOf(range, FORGE_CORE_SURFACES, landed);
    expect(out.surfaces.find((s) => s.surface === 'ui')?.artifacts).toEqual([
      { ref: VISUAL, change: 'changed', issues: [], carriedBy: null },
    ]);
    expect(out.unclassified).toEqual([
      { key: null, why: expect.stringMatching(/no rule of `surfaces`/), paths: ['biome.json', 'packages/core/tsconfig.json'] },
    ]);
    expect(out.boxRead).toEqual([]);
  });

  it('raises no data-shape risk for the journal, and keeps the design revisions that ship nothing', () => {
    const out = rangeChangesOf(range, FORGE_CORE_SURFACES, landed);
    expect(out.risks).toEqual([]);
    expect(out.surfaces.find((s) => s.surface === 'design')?.artifacts.map((a) => a.ref)).toEqual(['WF-3 r2']);
  });

  it('shows every changed path as it is where the project declares no map', () => {
    const out = rangeChangesOf(range, null, landed);
    expect(out.surfaces.map((s) => s.surface)).toEqual(['design']);
    expect(out.unclassified).toEqual([
      { key: null, why: expect.stringMatching(/declares no `surfaces`/), paths: [...range.map((c) => c.path)].sort() },
    ]);
  });
});
