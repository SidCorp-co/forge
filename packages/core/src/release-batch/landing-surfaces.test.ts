import { describe, expect, it } from 'vitest';
import type { SourceHost } from '../integrations/source-host/index.js';
import type { ProjectDocument } from '../project-config/index.js';
import { releaseRuleSchema } from '../project-config/release-rule-schema.js';
import {
  classifyChanges,
  FORGE_CORE_SURFACES,
  readLandingReadings,
  releaseChangesOf,
  surfaceMapOf,
} from './landing-surfaces.js';

const gitDocument = (repository: string, surfaces?: unknown) =>
  ({
    source: { type: 'git', git: { repository, defaultBranch: 'main', branches: ['main'] } },
    ...(surfaces ? { release: { approval: { required: false }, surfaces } } : {}),
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

  it('ships the default map only for the forge-core repository, and a declared map wins over it', () => {
    expect(surfaceMapOf(gitDocument('github.com/SidCorp-co/forge-core'))).toBe(FORGE_CORE_SURFACES);
    expect(surfaceMapOf(gitDocument('github.com/acme/shop'))).toBeNull();
    const declared = { rules: [{ surface: 'ui', paths: ['web/**'] }] };
    expect(surfaceMapOf(gitDocument('github.com/SidCorp-co/forge-core', declared))).toEqual(
      declared,
    );
    expect(surfaceMapOf(null)).toBeNull();
  });

  it('reads an observed commit through the host into named artifacts, and an unmapped project as unclassified paths', async () => {
    const facts = [
      { id: 'a', marked: true, landing: null, artifacts: null, commitSha: 'a'.repeat(40) },
    ];
    const core = await readLandingReadings('p', facts, {
      document: async () => gitDocument('github.com/SidCorp-co/forge-core'),
      host: async () => hostWith('SidCorp-co/forge-core', CHANGES),
    });
    expect(core.get('a')).toMatchObject({ kind: 'named', unmappedPaths: ['LICENSE'] });

    const other = await readLandingReadings('p', facts, {
      document: async () => gitDocument('github.com/acme/shop'),
      host: async () => hostWith('acme/shop', CHANGES),
    });
    expect(other.get('a')).toMatchObject({
      kind: 'unclassified',
      why: expect.stringMatching(/declares no `release.surfaces`/),
      paths: expect.arrayContaining(['LICENSE', 'packages/core/src/issues/merge-routes.ts']),
    });
  });

  it('refuses a map naming a surface no path can be, by name', () => {
    const parsed = releaseRuleSchema.safeParse({
      approval: { required: false },
      surfaces: { rules: [{ surface: 'design', paths: ['docs/**'] }] },
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
          artifacts: [
            { surface: 'data', ref: 'table:cases', change: 'changed' },
            { surface: 'api', ref: 'DELETE /cases/:id', change: 'removed' },
            { surface: 'api', ref: 'POST /cases', change: 'added' },
          ],
        },
      },
    ]);
    expect(changes.risks.map((r) => r.risk)).toEqual(['api_removed', 'data_changed']);
    expect(changes.surfaces.map((s) => [s.surface, s.count])).toEqual([
      ['api', 2],
      ['data', 1],
    ]);
  });
});
