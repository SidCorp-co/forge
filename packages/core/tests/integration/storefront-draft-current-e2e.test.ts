import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
} from '../helpers/index.js';

const JUDGED = 'c12bebe9'.padEnd(64, '0');
const CURRENT = 'dcfd728e'.padEnd(64, '0');

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let ownerToken: string;
const issueId = randomUUID();

type Reading =
  | { kind: 'read'; draftVersion: string; workflowCode: string }
  | { kind: 'unreadable'; detail: string };
const reads = (draftVersion: string) => async (): Promise<Reading> => ({
  kind: 'read',
  draftVersion,
  workflowCode: 'discharge',
});

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  ownerToken = await (await import('../../src/auth/jwt.js')).signUserToken(owner.id);
  const doc = JSON.parse(
    readFileSync(
      new URL('../../src/project-config/fixtures/examples/hop.project.json', import.meta.url),
      'utf8',
    ),
  );
  doc.project = { ...doc.project, id: projectId, slug: `hop-${projectId.slice(0, 8)}` };
  await harness.db.execute(sql`
    INSERT INTO project_config_documents (project_id, revision, document, updated_by)
    VALUES (${projectId}, 1, ${JSON.stringify(doc)}::jsonb, ${ownerId})
  `);
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 14, 'discharge storefront build', 'in_progress', ${ownerId})
  `);
  const { db } = await import('../../src/db/client.js');
  const { putCriteria, recordVerdict } = await import('../../src/issues/criteria/store.js');
  await db.transaction((tx) =>
    putCriteria(tx, issueId, [
      { n: 1, statement: 'the discharge form saves' },
      { n: 2, statement: 'the summary renders' },
    ]),
  );
  for (const criterion of [1, 2]) {
    await db.transaction((tx) =>
      recordVerdict(tx, {
        issue: { id: issueId, projectId },
        draft: {
          criterion,
          verdict: 'pass',
          reason: null,
          identity: {
            kind: 'storefront_draft',
            workflowId: '102',
            draftVersion: JUDGED,
            environment: 'preview',
          },
          evidence: [],
        },
        author: { userId: ownerId, deviceId: null, agency: 'agent' },
        readDraft: reads(JUDGED),
      }),
    );
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

async function gate(readDraft?: () => Promise<Reading>) {
  const { db } = await import('../../src/db/client.js');
  const { guardFault } = await import('../../src/issues/transition-guards.js');
  return guardFault({
    issue: { id: issueId, projectId },
    from: 'in_progress',
    to: 'awaiting_release',
    agency: 'agent',
    executor: db,
    ...(readDraft ? { readDraft } : {}),
  });
}

describe('FB-56 a storefront-draft verdict is weighed against the draft the storefront holds now (real Postgres)', () => {
  it('stores what the source held at write: corroborated', async () => {
    const rows = (await harness.db.execute(
      sql`SELECT corroboration FROM criterion_verdicts WHERE issue_id = ${issueId}`,
    )) as unknown as Array<{ corroboration: string }>;
    expect([...rows].map((r) => r.corroboration)).toEqual(['corroborated', 'corroborated']);
  });

  it('lets awaiting_release through while the storefront still holds the judged draft', async () => {
    await expect(gate(reads(JUDGED))).resolves.toBeNull();
  });

  it('refuses awaiting_release VERDICT_DRAFT_SUPERSEDED once the draft moved, naming both drafts', async () => {
    const refused = await gate(reads(CURRENT));
    expect(refused?.code).toBe('VERDICT_DRAFT_SUPERSEDED');
    expect(refused?.detail).toContain(`at draft version \`${CURRENT}\` now, not \`${JUDGED}\``);
    expect(refused?.details).toMatchObject({ superseded: [{ criterion: 1 }, { criterion: 2 }] });
  });

  it('refuses the close from in_progress alike', async () => {
    const { db } = await import('../../src/db/client.js');
    const { guardFault } = await import('../../src/issues/transition-guards.js');
    const refused = await guardFault({
      issue: { id: issueId, projectId },
      from: 'in_progress',
      to: 'closed',
      agency: 'agent',
      executor: db,
      readDraft: reads(CURRENT),
    });
    expect(refused?.code).toBe('VERDICT_DRAFT_SUPERSEDED');
  });

  it('planted unreadable source: with the real reader and a binding core does not hold, the gate refuses VERDICT_UNCORROBORATED, never passes', async () => {
    const refused = await gate();
    expect(refused?.code).toBe('VERDICT_UNCORROBORATED');
    expect(refused?.detail).toContain('could not be read');
    expect(refused?.detail).toContain('which core does not hold');
  });

  it('the issue read answers the reading of now, not the word stored', async () => {
    const res = await fetch(`${server.baseUrl}/api/issues/${issueId}/criteria`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      criteria: Array<{ latest: { corroboration: string; corroborationNote: string } }>;
    };
    expect(body.criteria.map((c) => c.latest.corroboration)).toEqual([
      'uncorroborated',
      'uncorroborated',
    ]);
    expect(body.criteria[0]?.latest.corroborationNote).toContain('which core does not hold');
  });
});

describe('FB-56 the issue list does not call a draft verdict passing once nothing confirms the draft (real Postgres)', () => {
  it('counts no storefront verdict passing and puts the issue on the master, while a commit verdict still passes', async () => {
    const controlId = randomUUID();
    const criterion = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${controlId}, ${projectId}, 15, 'commit-judged control', 'awaiting_release', ${ownerId})
    `);
    await harness.db.execute(sql`
      INSERT INTO issue_criteria (id, issue_id, n, statement, position)
      VALUES (${criterion}, ${controlId}, 1, 'the endpoint answers', 0)
    `);
    await harness.db.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha, author_agency)
      VALUES (${criterion}, ${controlId}, 'pass', 'commit', ${'3641ba21fec5096e2d1a91a40f2d9e50e9239068'}, 'agent')
    `);
    await harness.db.execute(
      sql`UPDATE issues SET status = 'awaiting_release' WHERE id = ${issueId}`,
    );

    const { listIssueStanding } = await import('../../src/issues/standing-read.js');
    const list = await listIssueStanding(projectId, 'open', null);
    const judged = list.issues.find((i) => i.id === issueId)?.standing;
    expect(judged?.criteria).toMatchObject({ total: 2, passing: 0 });
    expect(judged?.attentionGroup).toBe('stuck');
    expect(judged?.waitingOn).toMatchObject({ kind: 'master', act: 'judge it again' });
    expect(judged?.waitingOn.rule).toContain('2 of 2 criteria have no verdict that passes now');

    const control = list.issues.find((i) => i.id === controlId)?.standing;
    expect(control?.criteria).toMatchObject({ total: 1, passing: 1 });
    expect(control?.waitingOn.act).not.toBe('judge it again');
  });
});
