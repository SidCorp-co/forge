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
 * ISS-1437: ISS-1426's commit f1838fc8 changed forge-api.openapi.json, ISS-1431's later commit in the
 * same batch changed it again, and forge-api 3.0.1 was recorded from the batch head dc2ebebb. The
 * mark at f1838fc8 was refused, and the only answer was recording a file nothing served as the
 * registry's latest. A decided version recorded from the head of the passing merge check covering
 * the commit now holds it; with none, the refusal asks for the batch head's file.
 *
 * ISS-1435 (catalog-api FB-834): an openapi contract kept in YAML was refused ARTIFACT_UNREADABLE,
 * and its JSON conversion CONTRACT_SOURCE_DIGEST_MISMATCH against the YAML file, so its versions
 * were recorded with no sourceRef. YAML is now read as JSON is, and the digest is the bytes sent.
 * oasdiff is stubbed here: this suite's subject is the door, and `oasdiff-yaml.test.ts` runs the
 * pinned binary itself on YAML.
 *
 * @direct-test-of packages/core/src/ecosystem/contract/source-ref.ts
 * @direct-test-of packages/core/src/ecosystem/contract/publish.ts
 * @direct-test-of packages/core/src/ecosystem/contract/landing-lag.ts
 * @direct-test-of packages/core/src/issues/mark-preconditions.ts
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
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
import { passingReport } from '../helpers/merge-check-report.js';
import { seedProjectDocument } from '../helpers/release-world.js';

vi.mock('../../src/ecosystem/contract/oasdiff.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/ecosystem/contract/oasdiff.js')>();
  return { ...real, requireOasdiff: async () => 'stub', oasdiffLoadError: async () => null };
});

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
          'catalog-admin': {
            title: 'Catalog admin',
            summary: 'The admin REST API.',
            type: 'openapi',
            artifact: { upload: true },
            lifecycle: 'production',
            ecosystems: [],
          },
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

/** ISS-1426's own commit in the batch, changing the contract file. */
const OWN = '1437aaaa'.repeat(5);
/** The batch head: a later commit of the same landing changed the file again. */
const BATCH_HEAD = '1437bbbb'.repeat(5);
const V4 = schemaOf({ site: { type: 'string' }, own: { type: 'string' } });
const V5 = schemaOf({
  site: { type: 'string' },
  own: { type: 'string' },
  head: { type: 'string' },
});

describe('ISS-1437 a batch issue is marked on the version recorded from its batch head', () => {
  const mark = (issueId: string, commit: string) =>
    say('platform', 'POST', `/api/issues/${issueId}/merge`, { commit, target: 'main' });
  const issueAt = async (seq: number) =>
    (
      await createTestIssue(w.project.internal, w.user.platform, seq, {
        status: 'in_progress',
        createdAt: new Date(),
      })
    ).id;
  /** The batch's passing merge check, recorded on `issueId` over OWN..BATCH_HEAD. */
  const batchChecked = async (issueId: string) => {
    const { writeCoreRecord } = await import('../../src/issues/record-events/store.js');
    const { recordFields } = await import('../../src/issues/merge-check-rules.js');
    const report = {
      ...passingReport({
        base: { branch: 'main', sha: LANDED },
        head: BATCH_HEAD,
        touched: [{ path: PATH, change: 'changed' }],
      }),
      commits: [BATCH_HEAD, OWN],
    };
    await writeCoreRecord(db, {
      issueId,
      actor: { type: 'user', id: w.user.platform, agency: 'human' },
      kind: 'verification',
      fields: recordFields(report, [], { fastDelivery: false, debtIds: [] }),
    });
  };
  const decide = (version: string) =>
    say(
      'platform',
      'POST',
      `/api/projects/${w.project.internal}/contracts/site-sync-events/versions/${version}/decision`,
      { decision: 'approve' },
    );

  beforeEach(() => {
    host.onMain = new Set([LANDED, OWN, BATCH_HEAD]);
    host.files.set(`${PATH}@${OWN}`, V4);
    host.files.set(`${PATH}@${BATCH_HEAD}`, V5);
    host.commits = new Map([
      [OWN, [PATH]],
      [BATCH_HEAD, [PATH, 'src/routes.ts']],
    ]);
  });

  it("refuses a batch issue while no version holds the file, asking for the batch head's file, not its own commit's", async () => {
    const issue = await issueAt(14371);
    await batchChecked(issue);

    const unrecorded = await mark(issue, OWN);
    expect(refusal(unrecorded)).toEqual(['CONTRACT_VERSION_UNRECORDED /commit']);
    expect(detailOf(unrecorded)).toContain(`sourceRef: "${PATH}@${BATCH_HEAD}"`);
    expect(detailOf(unrecorded)).not.toContain(`${PATH}@${OWN}`);
    expect(detailOf(unrecorded)).toContain(`sits in a batch landed at ${BATCH_HEAD}`);
  });

  it("refuses while the batch head's version is proposed, then marks the issue at its own commit once it is decided", async () => {
    const issue = await issueAt(14372);
    await batchChecked(issue);
    const recorded = ok(await upload(V5, `${PATH}@${BATCH_HEAD}`), 201);

    const undecided = await mark(issue, OWN);
    expect(refusal(undecided)).toEqual(['CONTRACT_VERSION_UNDECIDED /commit']);
    expect(detailOf(undecided)).toContain(
      `site-sync-events@${recorded.version.contractVersion} holds ${PATH}`,
    );

    ok(await decide(recorded.version.contractVersion));
    ok(await mark(issue, OWN));

    // nothing was recorded from OWN's file: the registry's latest is still the batch head's
    const latest = ok(
      await say(
        'platform',
        'GET',
        `/api/projects/${w.project.internal}/contracts/site-sync-events/versions`,
      ),
    );
    expect(JSON.stringify(latest)).not.toContain(`${PATH}@${OWN}`);
  });

  it('still refuses an issue no passing merge check places in that batch, naming its own commit', async () => {
    // the batch head's version is decided above; this issue's commit is covered by no check
    const issue = await issueAt(14373);

    const unrecorded = await mark(issue, OWN);
    expect(refusal(unrecorded)).toEqual(['CONTRACT_VERSION_UNRECORDED /commit']);
    expect(detailOf(unrecorded)).toContain(`sourceRef: "${PATH}@${OWN}"`);
  });
});

const OPENAPI_PATH = 'docs/contracts/admin-rest-v1/openapi.yaml';
const OPENAPI_YAML = `openapi: 3.1.0
info:
  title: catalog admin
  version: 11.1.0
paths:
  /products:
    get:
      responses:
        "200":
          description: the products
`;
const OPENAPI_JSON_PATH = 'docs/contracts/admin-rest-v1/openapi.json';
const OPENAPI_JSON = `${JSON.stringify(
  {
    openapi: '3.1.0',
    info: { title: 'catalog admin', version: '11.1.0' },
    paths: { '/products': { get: { responses: { 200: { description: 'the products' } } } } },
  },
  null,
  2,
)}\n`;

describe('ISS-1435 an openapi contract kept in YAML is recorded from its landed file', () => {
  let openapiVersion = 10;
  const publish = (artifact: string, sourceRef?: string) =>
    say(
      'platform',
      'POST',
      `/api/projects/${w.project.internal}/contracts/catalog-admin/versions`,
      {
        kind: 'openapi',
        artifact,
        version: `${++openapiVersion}.0.0`,
        ...(sourceRef ? { sourceRef } : {}),
      },
    );

  beforeEach(() => {
    host.files.set(`${OPENAPI_PATH}@${LANDED}`, OPENAPI_YAML);
    host.files.set(`${OPENAPI_JSON_PATH}@${LANDED}`, OPENAPI_JSON);
  });

  it("refuses YAML that does not parse, naming the parser's error and its line and column", async () => {
    const r = await publish('openapi: 3.1.0\ninfo:\n  title: [catalog\n');

    expect(refusal(r)).toEqual(['ARTIFACT_UNREADABLE /artifact']);
    expect(detailOf(r)).toContain('an openapi artifact is JSON or YAML');
    expect(detailOf(r)).toMatch(/YAML \(BAD_INDENT: .* at line 4, column 1\)/);
  });

  it('refuses the JSON converted from a YAML file, saying the file is YAML and its own text is sent', async () => {
    const converted = `${JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'catalog admin', version: '11.1.0' },
      paths: { '/products': { get: { responses: { 200: { description: 'the products' } } } } },
    })}`;
    const r = await publish(converted, `${OPENAPI_PATH}@${LANDED}`);

    expect(refusal(r)).toEqual(['CONTRACT_SOURCE_DIGEST_MISMATCH /artifact']);
    expect(detailOf(r)).toContain(`The file at ${OPENAPI_PATH}@${LANDED} is YAML`);
    expect(detailOf(r)).toContain("send the file's own YAML text");
  });

  it('records the landed YAML file at its landed commit', async () => {
    const r = ok(await publish(OPENAPI_YAML, `${OPENAPI_PATH}@${LANDED}`), 201);

    expect(r.version.artifact).toMatchObject({ sourceRef: `${OPENAPI_PATH}@${LANDED}` });
    expect(r.version.artifact.sha256).toBe(createHash('sha256').update(OPENAPI_YAML).digest('hex'));
  });

  it('records a JSON openapi file as before, and refuses JSON that does not parse as JSON', async () => {
    const r = ok(await publish(OPENAPI_JSON, `${OPENAPI_JSON_PATH}@${LANDED}`), 201);
    expect(r.version.artifact).toMatchObject({ sourceRef: `${OPENAPI_JSON_PATH}@${LANDED}` });

    const broken = await publish('{"openapi": "3.1.0", "info": ');
    expect(refusal(broken)).toEqual(['ARTIFACT_UNREADABLE /artifact']);
    expect(detailOf(broken)).toContain('reads as JSON and does not parse');
  });
});
