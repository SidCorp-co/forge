/**
 * ISS-981 (catalog-api FB-501): contract site-sync-events-v1 2.0.0 was recorded from 0531e1dd, a commit
 * that never landed, not from the landed artifact at a2c403e4, and the contract-version door took it,
 * checking only the approval, the proposal and the schema id. A version's `sourceRef` commit must now
 * be on the project's base branch, and a json-schema, openapi or graphql artifact must be the file at
 * that path and commit, byte for byte, read from the source host; where the host cannot be read the
 * refusal says so. The host is planted through the project's ancestry source, as the release-hold
 * ancestry test plants it. Through the app's own routes, against real Postgres.
 *
 * ISS-1419: forge-api stood at 2.0.0 while every landing moved `forge-api.openapi.json`, since no
 * landing recorded a version. A merge mark at a commit whose change carries a contract's source file
 * is now refused by name until a decided version holds that file as the commit left it.
 *
 * @direct-test-of packages/core/src/ecosystem/contract/source-ref.ts
 * @direct-test-of packages/core/src/ecosystem/contract/publish.ts
 * @direct-test-of packages/core/src/ecosystem/contract/landing-lag.ts
 * @direct-test-of packages/core/src/issues/mark-preconditions.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceHost } from '../../src/integrations/source-host/index.js';
import type { AncestrySource } from '../../src/release-batch/ancestry-source.js';
import {
  closeWorld,
  type EcosystemWorld,
  ok,
  openWorld,
  refusal,
  sender,
} from '../helpers/ecosystem-world.js';
import { createTestIssue } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** a2c403e4, where catalog-api's schema landed on main. */
const LANDED = 'a2c403e4b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
/** 0531e1dd, the branch commit the version was recorded from, which never landed. */
const NEVER_LANDED = '0531e1dd00000000000000000000000000000000';
const PATH = 'schemas/site-sync-events-v1.json';

const schemaOf = (properties: Record<string, unknown>) =>
  `${JSON.stringify(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'site sync events',
      type: 'object',
      properties,
    },
    null,
    2,
  )}\n`;
const V1 = schemaOf({ site: { type: 'string' } });
const V2 = schemaOf({ site: { type: 'string' }, at: { type: 'string' } });

/** What the planted host holds: the commits on `main`, and each file at each commit. */
const host = {
  kind: 'host' as 'host' | 'none' | 'throws',
  onMain: new Set<string>(),
  files: new Map<string, string>(),
  /** The files each commit changed against its parent. */
  commits: new Map<string, string[]>(),
};
const branchesAsked: string[] = [];

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
  ancestrySourceFor: async (): Promise<AncestrySource> => {
    if (host.kind === 'none') {
      return {
        kind: 'none',
        why: "the project's repository binding cannot serve: its GitLab token was revoked",
      };
    }
    const planted = {
      async branchContains(branch: string, commit: string) {
        if (host.kind === 'throws') throw new Error('GitLab answered 503');
        branchesAsked.push(branch);
        return branch === 'main' && host.onMain.has(commit);
      },
      async readFile(path: string, ref: string) {
        return host.files.get(`${path}@${ref}`) ?? { missing: `no blob at ${path}` };
      },
      async commitFiles(sha: string) {
        const files = host.commits.get(sha);
        if (!files) return { why: `no commit ${sha}` };
        return { files, changes: files.map((path) => ({ path, change: 'changed' })) };
      },
      async compareFiles() {
        return { why: 'no merge check base is planted' };
      },
    } as unknown as SourceHost;
    return {
      kind: 'host',
      host: planted,
      reader: { ask: async () => new Map(), witness: () => ({ via: 'source-host' }) },
    };
  },
}));

let w: EcosystemWorld;
let say: ReturnType<typeof sender>;
let version = 0;

const upload = (artifact: string, sourceRef?: string) =>
  say(
    'platform',
    'POST',
    `/api/projects/${w.project.internal}/contracts/site-sync-events/versions`,
    {
      kind: 'json-schema',
      artifact,
      version: `${++version}.0.0`,
      ...(sourceRef ? { sourceRef } : {}),
    },
  );

beforeAll(async () => {
  w = await openWorld();
  say = sender(w);
  ok(
    await say('platform', 'PUT', `/api/projects/${w.project.internal}/interface`, {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/interface-v1.json',
        version: 1,
        project: w.project.internal,
        publishes: {
          'site-sync-events': {
            title: 'Site sync events',
            summary: 'The events a site sync emits.',
            type: 'json-schema',
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
  await seedProjectDocument(w.project.internal, w.user.platform, {
    defaultBranch: 'main',
    environments: {},
  });
}, 120_000);

beforeEach(() => {
  host.kind = 'host';
  host.onMain = new Set([LANDED]);
  host.files = new Map([
    [`${PATH}@${LANDED}`, V1],
    [`${PATH}@${NEVER_LANDED}`, V2],
  ]);
  host.commits = new Map();
  branchesAsked.length = 0;
});

afterAll(async () => {
  await closeWorld();
});

const detailOf = (r: { json: { error?: { refusals?: Array<{ detail: string }> } } }) =>
  r.json.error?.refusals?.[0]?.detail ?? '';

describe('ISS-981 a contract version is recorded only from a file the landing holds', () => {
  it("refuses catalog-api's version recorded from a commit that never landed, naming the base branch", async () => {
    const r = await upload(V2, `${PATH}@${NEVER_LANDED}`);

    expect(refusal(r)).toEqual(['CONTRACT_SOURCE_NOT_LANDED /sourceRef']);
    expect(detailOf(r)).toContain(`${NEVER_LANDED} is not on \`main\``);
    expect(branchesAsked).toEqual(['main']);
  });

  it('refuses an artifact whose sha256 differs from the file at the landed commit', async () => {
    const r = await upload(V2, `${PATH}@${LANDED}`);

    expect(refusal(r)).toEqual(['CONTRACT_SOURCE_DIGEST_MISMATCH /artifact']);
    expect(detailOf(r)).toContain(`is not the file at ${PATH}@${LANDED}`);
  });

  it('refuses a sourceRef naming no file at that commit', async () => {
    const r = await upload(V1, `schemas@${LANDED}`);

    expect(refusal(r)).toEqual(['CONTRACT_SOURCE_FILE_MISSING /sourceRef']);
    expect(detailOf(r)).toContain('no blob at schemas');
  });

  it('refuses by name where the project has no source host to read, and does not guess', async () => {
    host.kind = 'none';

    const r = await upload(V1, `${PATH}@${LANDED}`);

    expect(refusal(r)).toEqual(['CONTRACT_SOURCE_UNREAD /sourceRef']);
    expect(detailOf(r)).toContain('its GitLab token was revoked');
  });

  it('refuses by name where the source host fails to answer', async () => {
    host.kind = 'throws';

    const r = await upload(V1, `${PATH}@${LANDED}`);

    expect(refusal(r)).toEqual(['CONTRACT_SOURCE_UNREAD /sourceRef']);
    expect(detailOf(r)).toContain('GitLab answered 503');
  });

  it('records the landed file at its landed commit', async () => {
    const r = ok(await upload(V1, `${PATH}@${LANDED}`), 201);

    expect(r.version.artifact).toMatchObject({ sourceRef: `${PATH}@${LANDED}` });
  });

  it('records a version naming no sourceRef as before, asking no host', async () => {
    ok(await upload(V2), 201);
    expect(branchesAsked).toEqual([]);
  });
});

/** A landing on main after the versions above: the schema gains `by`. */
const MOVED = '1419aaaa'.repeat(5);
/** A landing on main changing no contract file. */
const UNRELATED = '1419bbbb'.repeat(5);
const V3 = schemaOf({ site: { type: 'string' }, at: { type: 'string' }, by: { type: 'string' } });

describe('ISS-1419 a landing that changes a contract file leaves a decided version holding it', () => {
  const mark = (issueId: string, commit: string) =>
    say('platform', 'POST', `/api/issues/${issueId}/merge`, { commit, target: 'main' });
  const issueAt = async (seq: number) =>
    (
      await createTestIssue(w.project.internal, w.user.platform, seq, {
        status: 'in_progress',
        createdAt: new Date(),
      })
    ).id;

  beforeEach(() => {
    host.onMain = new Set([LANDED, MOVED, UNRELATED]);
    host.files.set(`${PATH}@${MOVED}`, V3);
    host.commits = new Map([
      [MOVED, [PATH, 'src/routes.ts']],
      [UNRELATED, ['README.md']],
    ]);
  });

  it('marks a landing that changes no contract file, asking nothing of the registry', async () => {
    ok(await mark(await issueAt(14191), UNRELATED));
  });

  it('refuses the mark while no version holds the file, then while it is proposed, then marks it', async () => {
    const issue = await issueAt(14192);

    const unrecorded = await mark(issue, MOVED);
    expect(refusal(unrecorded)).toEqual(['CONTRACT_VERSION_UNRECORDED /commit']);
    expect(detailOf(unrecorded)).toContain(`sourceRef: "${PATH}@${MOVED}"`);

    const recorded = ok(await upload(V3, `${PATH}@${MOVED}`), 201);
    const undecided = await mark(issue, MOVED);
    expect(refusal(undecided)).toEqual(['CONTRACT_VERSION_UNDECIDED /commit']);
    expect(detailOf(undecided)).toContain(
      `site-sync-events@${recorded.version.contractVersion} holds ${PATH}`,
    );

    ok(
      await say(
        'platform',
        'POST',
        `/api/projects/${w.project.internal}/contracts/site-sync-events/versions/${recorded.version.contractVersion}/decision`,
        { decision: 'approve' },
      ),
    );
    ok(await mark(issue, MOVED));

    // a later landing that carries the same bytes is held by the version holding them
    const again = '1419cccc'.repeat(5);
    host.files.set(`${PATH}@${again}`, V3);
    host.commits.set(again, [PATH]);
    ok(await mark(await issueAt(14193), again));
  });
});
