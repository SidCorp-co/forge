import { randomUUID } from 'node:crypto';
import type { ReportDocument } from '@forge/contracts/report-templates';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { hashShareToken, mintShareToken } from '../../src/shares/token.js';
import { api, type Body, patToken, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// A share link shows one frozen, scrubbed answer and nothing else. It stops answering the moment it
// expires or is revoked, or its creator leaves the project, and every one of those answers the same
// way as a token that never existed. A members share opens only for someone who can read the
// project; a share open to anyone needs `shares.public` and a project whose data may leave it.

const SECRET = `ghp_${'q9W8e7R6t5'.repeat(4)}`;
const EMAIL = 'linh.tran@example.com';

function plantedDocument(projectId: string): ReportDocument {
  const frame = {
    fields: [
      { name: 'requirement', type: 'ref' as const, label: 'Requirement' },
      { name: 'note', type: 'string' as const, label: 'Note' },
      { name: 'proven', type: 'number' as const, label: 'Proven' },
    ],
    rows: [{ requirement: 'REQ-1', note: `owner ${EMAIL}, key ${SECRET}`, proven: 4 }],
  };
  return {
    templateId: 'progress',
    version: 1,
    params: {},
    runs: [
      {
        runId: 'run-1',
        queryId: 'progress-by-requirement',
        version: 1,
        params: {},
        projectId,
        actor: { kind: 'human', id: randomUUID() },
        asOf: '2026-10-08T09:00:00.000Z',
        frame,
      },
    ],
    blocks: [
      {
        kind: 'table',
        v: 1,
        title: `Progress for ${EMAIL}`,
        columns: ['requirement', 'note', 'proven'],
        source: { runId: 'run-1' },
        frame,
      },
    ],
    narrative: {
      summary: `Asked by ${EMAIL}.`,
      risks: `Token ${SECRET}.`,
      recommendations: 'None.',
    },
  };
}

// The link's own behaviour is exercised over a kept template report whose document holds a secret
// and an email address, stored as the status-reports module keeps one (REQ-32 B3).
const kept = new Map<string, string>();
const keep = async (project: string, userId: string): Promise<string> => {
  const document = plantedDocument(project);
  const [row] = await db.execute<{ id: string }>(sql`
    INSERT INTO status_reports (project_id, producer_kind, produced_by, as_of, template_id, template_version, document)
    VALUES (${project}, 'person', ${userId}, now(), ${document.templateId}, ${document.version}, ${JSON.stringify(document)}::jsonb)
    RETURNING id
  `);
  kept.set(project, String(row?.id));
  return String(row?.id);
};

interface Person {
  id: string;
  token: string;
}

let projectId: string;
let admin: Person;
let member: Person;
let other: Person;
let viewer: Person;
let outsider: Person;

const person = async (role?: 'member' | 'viewer', project = () => projectId) => {
  const u = await createTestUser({ verified: true });
  if (role) await addProjectMember(project(), u.id, role);
  return { id: u.id, token: await userToken(u.id) };
};
const create = (who: Person, body: Body, project = projectId) =>
  api(who.token, 'POST', `/api/projects/${project}/shares`, {
    subjectKind: 'status-report',
    subjectId: kept.get(project),
    ...body,
  });
const created = async (who: Person, body: Body, project = projectId) => {
  const res = await create(who, body, project);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const url = String(res.body.url);
  const token = url.slice(url.indexOf('/s/') + 3);
  return { token, share: res.body.share as Body };
};
const open = (token: string) => api(null, 'POST', '/api/shares/open', { token });
const openAs = (who: Person, token: string) =>
  api(who.token, 'POST', '/api/shares/open/member', { token });
const revoke = (who: Person, shareId: string) =>
  api(who.token, 'POST', `/api/projects/${projectId}/shares/${shareId}/revoke`);
const expectUnavailable = (res: { status: number; body: Body }) => {
  expect(res.status, JSON.stringify(res.body)).toBe(404);
  expect(res.body.code).toBe('SHARE_NOT_AVAILABLE');
};

beforeAll(async () => {
  const owner = await createTestUser({ verified: true });
  projectId = (await createTestProject(owner.id)).id;
  admin = { id: owner.id, token: await userToken(owner.id) };
  member = await person('member');
  other = await person('member');
  viewer = await person('viewer');
  outsider = await person();
  await keep(projectId, owner.id);
}, 120_000);

describe('opening a share', () => {
  it('shows a members share once, to members only, and keeps only the hash of its token', async () => {
    const { token, share } = await created(member, { audience: 'members' });
    expect(token).toMatch(/^forge_share_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(share)).not.toContain(token);
    const [row] = await db.execute<{ token_hash: string; whole: string }>(sql`
      SELECT token_hash, row_to_json(share_links)::text AS whole FROM share_links WHERE id = ${share.id as string}
    `);
    expect(row?.token_hash).toBe(hashShareToken(token));
    expect(row?.whole).not.toContain(token.slice(12));

    const seen = await openAs(other, token);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body.audience).toBe('members');
    expect(seen.headers.get('cache-control')).toBe('no-store');
    expect(seen.headers.get('referrer-policy')).toBe('no-referrer');
    expect(seen.headers.get('x-robots-tag')).toContain('noindex');
    expect(Object.keys(seen.body).sort()).toEqual(['audience', 'document', 'expiresAt']);
  });

  it('refuses a members share to nobody signed in and to someone outside the project', async () => {
    const { token } = await created(member, { audience: 'members' });
    const anonymous = await open(token);
    expect(anonymous.status, JSON.stringify(anonymous.body)).toBe(403);
    expect(anonymous.body.code).toBe('SHARE_SIGN_IN_REQUIRED');
    const stranger = await openAs(outsider, token);
    expect(stranger.status, JSON.stringify(stranger.body)).toBe(403);
    expect(stranger.body.code).toBe('SHARE_AUDIENCE_FORBIDDEN');
  });

  it('freezes a snapshot with the planted secret and email scrubbed out', async () => {
    const { token, share } = await created(admin, { audience: 'link' });
    const seen = await open(token);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    const shown = JSON.stringify(seen.body);
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain(EMAIL);
    expect(shown).toContain('[email]');
    const doc = seen.body.document as ReportDocument;
    expect(doc.runs[0]?.frame.rows[0]?.proven).toBe(4);
    const [row] = await db.execute<{ snapshot: string }>(sql`
      SELECT snapshot::text AS snapshot FROM share_links WHERE id = ${share.id as string}
    `);
    expect(row?.snapshot).not.toContain(SECRET);
    expect(row?.snapshot).not.toContain(EMAIL);
  });

  it('answers a tampered token as one that never existed, and a malformed one by its shape', async () => {
    const { token } = await created(admin, { audience: 'link' });
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    expectUnavailable(await open(`${token.slice(0, -1)}${last}`));
    const malformed = await open('not-a-share-token');
    expect(malformed.status, JSON.stringify(malformed.body)).toBe(400);
    expect(malformed.body.code).toBe('SHARE_TOKEN_MALFORMED');
    expect((await open(token)).status).toBe(200);
  });

  it('counts each view and keeps the snapshot frozen', async () => {
    const { token, share } = await created(admin, { audience: 'link' });
    await open(token);
    await open(token);
    const listed = await api(member.token, 'GET', `/api/projects/${projectId}/shares`);
    const row = (listed.body.shares as Body[]).find((s) => s.id === share.id);
    expect(row?.viewCount).toBe(2);
    expect(row?.lastViewedAt).not.toBeNull();
    expect(row?.title).toBe('Progress for [email]');
    expect(JSON.stringify(listed.body)).not.toContain(EMAIL);
    const refused = await db
      .execute(sql`UPDATE share_links SET snapshot = '{}'::jsonb WHERE id = ${share.id as string}`)
      .then(
        () => 'written',
        (err: Error) => String((err.cause as Error | undefined)?.message ?? err.message),
      );
    expect(refused).toContain('SHARE_LINK_FROZEN');
  });
});

describe('creating a share', () => {
  it('refuses each permission by name: shares.write for a viewer, shares.public for a member', async () => {
    const byViewer = await create(viewer, { audience: 'members' });
    expect(byViewer.status, JSON.stringify(byViewer.body)).toBe(403);
    expect(byViewer.body.code).toBe('PERMISSION_FORBIDDEN');
    expect(String(byViewer.body.detail)).toContain('shares.write');
    const byMember = await create(member, { audience: 'link' });
    expect(byMember.status, JSON.stringify(byMember.body)).toBe(403);
    expect(byMember.body.code).toBe('PERMISSION_FORBIDDEN');
    expect(String(byMember.body.detail)).toContain('shares.public');
  });

  it('refuses a link share of a project whose data policy forbids data leaving it', async () => {
    const owner = await createTestUser({ verified: true });
    const closed = (await createTestProject(owner.id)).id;
    await seedProjectDocument(closed, owner.id, {
      environments: {},
      extra: { sensitiveData: 'no_egress' },
    });
    const who = { id: owner.id, token: await userToken(owner.id) };
    await keep(closed, owner.id);
    const link = await create(who, { audience: 'link' }, closed);
    expect(link.status, JSON.stringify(link.body)).toBe(403);
    expect(link.body.code).toBe('SHARE_EGRESS_FORBIDDEN');
    expect(String(link.body.detail)).toContain('no_egress');
    const members = await create(who, { audience: 'members' }, closed);
    expect(members.status, JSON.stringify(members.body)).toBe(201);
  });
});

describe('reading which audiences a person may share with', () => {
  const audiences = async (who: Person, project = projectId) => {
    const res = await api(who.token, 'GET', `/api/projects/${project}/shares/audiences`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return Object.fromEntries(
      (res.body.audiences as Body[]).map((a) => [a.audience as string, a.refusal as Body | null]),
    );
  };

  it("answers each audience with the refusal creating one would answer, in core's words", async () => {
    expect(await audiences(admin)).toEqual({ members: null, link: null });
    const byMember = await audiences(member);
    expect(byMember.members).toBeNull();
    expect(byMember.link?.code).toBe('PERMISSION_FORBIDDEN');
    expect(String(byMember.link?.message)).toContain('shares.public');
    const refused = await create(member, { audience: 'link' });
    expect(byMember.link?.message).toBe(refused.body.detail);
    const byViewer = await audiences(viewer);
    expect(byViewer.members?.code).toBe('PERMISSION_FORBIDDEN');
    expect(String(byViewer.members?.message)).toContain('shares.write');
  });

  it('names the data policy for a project whose data may not leave it, and refuses an outsider', async () => {
    const owner = await createTestUser({ verified: true });
    const closed = (await createTestProject(owner.id)).id;
    await seedProjectDocument(closed, owner.id, {
      environments: {},
      extra: { sensitiveData: 'no_egress' },
    });
    const who = { id: owner.id, token: await userToken(owner.id) };
    const options = await audiences(who, closed);
    expect(options.members).toBeNull();
    expect(options.link?.code).toBe('SHARE_EGRESS_FORBIDDEN');
    expect(String(options.link?.message)).toContain('no_egress');
    const stranger = await api(
      outsider.token,
      'GET',
      `/api/projects/${projectId}/shares/audiences`,
    );
    expect(stranger.status, JSON.stringify(stranger.body)).toBeGreaterThanOrEqual(403);
    expect(stranger.status).toBeLessThanOrEqual(404);
  });
});

describe('a share stops answering', () => {
  it('expires on the day chosen, at most thirty days out, and is not available after', async () => {
    const { share } = await created(member, { audience: 'members', expiresInDays: 30 });
    const days =
      (Date.parse(share.expiresAt as string) - Date.parse(share.createdAt as string)) / 86_400_000;
    expect(days).toBeCloseTo(30, 2);
    const tooLong = await create(member, { audience: 'members', expiresInDays: 31 });
    expect(tooLong.status, JSON.stringify(tooLong.body)).toBe(400);
    expect(JSON.stringify(tooLong.body)).toContain('within 30 days at most');

    const { token, hash } = mintShareToken();
    await db.execute(sql`
      INSERT INTO share_links (project_id, token_hash, audience, subject_kind, snapshot, created_by, created_at, expires_at)
      VALUES (${projectId}, ${hash}, 'members', 'template-output', ${JSON.stringify(plantedDocument(projectId))}::jsonb,
              ${member.id}, now() - interval '8 days', now() - interval '1 day')
    `);
    expectUnavailable(await openAs(member, token));
  });

  it('stops answering the moment it is revoked, by its creator or an admin and nobody else', async () => {
    const mine = await created(member, { audience: 'members' });
    const byOther = await revoke(other, mine.share.id as string);
    expect(byOther.status, JSON.stringify(byOther.body)).toBe(403);
    expect(byOther.body.code).toBe('SHARE_REVOKE_FORBIDDEN');
    expect((await openAs(other, mine.token)).status).toBe(200);

    const byCreator = await revoke(member, mine.share.id as string);
    expect(byCreator.status, JSON.stringify(byCreator.body)).toBe(200);
    expect((byCreator.body.share as Body).revokedBy).toBe(member.id);
    expectUnavailable(await openAs(other, mine.token));
    const again = await revoke(member, mine.share.id as string);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.code).toBe('SHARE_ALREADY_REVOKED');

    const theirs = await created(member, { audience: 'members' });
    expect((await revoke(admin, theirs.share.id as string)).status).toBe(200);
    expectUnavailable(await openAs(member, theirs.token));
  });

  it('stops answering when its creator leaves the project', async () => {
    const leaver = await person('member');
    const { token, share } = await created(leaver, { audience: 'members' });
    expect((await openAs(member, token)).status).toBe(200);
    await db.execute(sql`
      DELETE FROM project_members WHERE project_id = ${projectId} AND user_id = ${leaver.id}
    `);
    expectUnavailable(await openAs(member, token));
    const listed = await api(admin.token, 'GET', `/api/projects/${projectId}/shares`);
    const row = (listed.body.shares as Body[]).find((s) => s.id === share.id);
    expect(row?.revokedAt).toBeNull();
  });
});

describe('credentials', () => {
  it('is never opened with a personal or agent token', async () => {
    const { token } = await created(member, { audience: 'members' });
    const pat = await patToken(member.id, [projectId]);
    const res = await api(pat, 'POST', '/api/shares/open/member', { token });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });
});
