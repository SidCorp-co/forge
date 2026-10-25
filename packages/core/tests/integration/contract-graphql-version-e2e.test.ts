import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  ok,
  openWorld,
  refusal,
  sender,
} from '../helpers/ecosystem-world.js';
import { addProjectMember } from '../helpers/factories.js';

// @direct-test-of packages/core/vitest.integration.config.ts
// FB-283's change rebuilt: autoflow's shop-mcp-graphql 1.1.0 added a mutation, an optional
// argument and two fields to 1.0.0, and was refused VERSION_BUMP_TOO_SMALL owing 2.0.0 (ISS-681)
const sdl = (v: string) =>
  readFileSync(
    new URL(`../fixtures/ecosystem/graphql/workflows-${v}.graphql`, import.meta.url),
    'utf8',
  );
const V1 = sdl('1.0.0');
const V1_1 = sdl('1.1.0');

let w: EcosystemWorld;
let say: ReturnType<typeof sender>;

const versions = () => `/api/projects/${w.project.internal}/contracts/workflows/versions`;
const upload = (artifact: string, version?: string) =>
  say('platform', 'POST', versions(), {
    kind: 'graphql',
    artifact,
    sourceRef: 'backend-go/internal/pkg/graphql@a376c3b',
    ...(version === undefined ? {} : { version }),
  });
const levelOf = (doc: Doc, check: string) =>
  (doc.diff.changes as Doc[]).filter((c) => c.check === check).map((c) => c.level);

beforeAll(async () => {
  w = await openWorld();
  say = sender(w);
  // a member writes contracts and holds no contracts.approve
  await addProjectMember(w.project.internal, w.user.viewer, 'member');
  ok(
    await say('platform', 'PUT', `/api/projects/${w.project.internal}/interface`, {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/interface-v1.json',
        version: 1,
        project: w.project.internal,
        publishes: {
          workflows: {
            title: 'Workflows',
            summary: 'The backend workflow editor over GraphQL.',
            type: 'graphql',
            artifact: { upload: true },
            lifecycle: 'production',
            ecosystems: [],
          },
        },
        consumes: [],
        commitments: {
          versioning: 'semver',
          deprecationNoticeDays: 30,
          responseDays: { rfi: 3, 'change-request': 7 },
        },
      },
    }),
  );
  const first = ok(await upload(V1, '1.0.0'), 201);
  expect(first.version.diff.classification).toBe('initial');
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a GraphQL change that breaks a caller still owes a MAJOR', () => {
  it('a removed field is refused at 1.1.0, owing 2.0.0', async () => {
    const r = await upload(V1.replace('  name: String!\n', ''), '1.1.0');
    expect(refusal(r)).toEqual(['VERSION_BUMP_TOO_SMALL /version']);
    expect(r.json.error.refusals[0].detail).toContain('measured breaking');
    expect(r.json.error.refusals[0].detail).toContain('2.0.0');
  });

  it('a required argument added is refused at 1.1.0', async () => {
    const r = await upload(
      V1.replace('definition: String!)', 'definition: String!, base_draft_version: Int!)'),
      '1.1.0',
    );
    expect(refusal(r)).toEqual(['VERSION_BUMP_TOO_SMALL /version']);
    expect(r.json.error.refusals[0].detail).toContain('measured breaking');
  });

  it('the additive change mixed with a removed field is refused at 1.1.0', async () => {
    const r = await upload(V1_1.replace('  name: String!\n', ''), '1.1.0');
    expect(refusal(r)).toEqual(['VERSION_BUMP_TOO_SMALL /version']);
    expect(r.json.error.refusals[0].detail).toContain('2.0.0');
  });
});

describe('an additive GraphQL change is a MINOR', () => {
  it("records FB-283's optional argument, mutation and fields at 1.1.0, non-breaking", async () => {
    const r = ok(await upload(V1_1, '1.1.0'), 201);
    expect(r.version.contractVersion).toBe('1.1.0');
    expect(r.version.diff.classification).toBe('non-breaking');
    expect(levelOf(r.version, 'graphql-field-argument-added')).toEqual([
      'info',
      'info',
      'info',
      'info',
    ]);
    expect(r.version.diff.changes.every((c: Doc) => c.level === 'info')).toBe(true);
  });
});

describe('a GraphQL change that stays unknown is recorded at the version its uploader names', () => {
  const withArchived = V1_1.replace('  PUBLISHED\n', '  PUBLISHED\n  ARCHIVED\n');

  it('naming no version is refused VERSION_CHANGE_UNKNOWN naming the change, never given a MAJOR', async () => {
    const r = await upload(withArchived);
    expect(refusal(r)).toEqual(['VERSION_CHANGE_UNKNOWN /version']);
    expect(r.json.error.refusals[0].detail).toContain('ARCHIVED');
    expect(r.json.error.refusals[0].detail).toContain('after 1.1.0');
  });

  it('an added enum value is recorded at 1.2.0, reading unknown with the change it could not judge', async () => {
    const r = ok(await upload(withArchived, '1.2.0'), 201);
    expect(r.version.contractVersion).toBe('1.2.0');
    expect(r.version.diff.classification).toBe('unknown');
    expect(levelOf(r.version, 'graphql-enum-value-added')).toEqual(['warning']);
  });
});

describe('a recorded GraphQL version is decided by a holder of contracts.approve', () => {
  const decide = (who: 'platform' | 'viewer', version: string) =>
    say(
      who,
      'POST',
      `/api/projects/${w.project.internal}/contracts/workflows/versions/${version}/decision`,
      { decision: 'approve' },
    );

  it('the non-breaking and the unknown version wait proposed', async () => {
    const read = ok(await say('platform', 'GET', versions()));
    const state = Object.fromEntries(
      (read.versions as Doc[]).map((v) => [v.contractVersion, v.approval.state]),
    );
    expect(state).toMatchObject({ '1.1.0': 'proposed', '1.2.0': 'proposed' });
  });

  it('a member without contracts.approve is refused PERMISSION_FORBIDDEN', async () => {
    for (const v of ['1.1.0', '1.2.0']) {
      const r = await decide('viewer', v);
      expect(r.status, JSON.stringify(r.json)).toBe(403);
      expect(r.json.error.refusals.map((x: Doc) => x.code)).toContain('PERMISSION_FORBIDDEN');
    }
  });

  it('the org owner approves each, and the unknown one becomes current', async () => {
    ok(await decide('platform', '1.1.0'));
    expect(ok(await say('platform', 'GET', versions())).current).toBe('1.1.0');
    ok(await decide('platform', '1.2.0'));
    expect(ok(await say('platform', 'GET', versions())).current).toBe('1.2.0');
  });
});
