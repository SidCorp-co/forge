/**
 * ISS-861: a ruling written as project knowledge reached only the project that wrote it, so every
 * other project went on as before. An organisation's always-on entry now reaches the prompt of every
 * project in the org, ahead of the project's own; a project entry under the same slug takes its
 * place; and only an org admin writes one, a member refused by name. Against real Postgres.
 *
 * @direct-test-of packages/core/src/knowledge/org-knowledge.ts
 * @direct-test-of packages/core/src/knowledge/org-knowledge-routes.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { servedCheckoutOrientation } from '../../src/prompt/checkout-orientation.js';
import { loadProjectFactInputs, renderStageFactsText } from '../../src/prompt/facts/resolve.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

const RULING = 'The agent is the only voice: core composes no words a person reads.';
const w = { orgId: '', projectId: '', otherId: '', slug: '', admin: '', member: '' };
const entry = (slug: string) => `/api/orgs/${w.orgId}/knowledge/${slug}`;
const preambleOf = async (projectId: string) =>
  renderStageFactsText(await loadProjectFactInputs(projectId), projectId, 'plan');

beforeAll(async () => {
  const admin = await createTestUser({ verified: true });
  const member = await createTestUser({ verified: true });
  const project = await createTestProject(admin.id);
  w.orgId = project.orgId;
  w.projectId = project.id;
  w.slug = project.slug;
  w.otherId = (await createTestProject(admin.id, { orgId: w.orgId })).id;
  await addProjectMember(w.projectId, admin.id, 'owner');
  await db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role) VALUES (${w.orgId}, ${member.id}, 'member')`);
  w.admin = await userToken(admin.id);
  w.member = await userToken(member.id);
});

describe('org knowledge (ISS-861)', () => {
  it('refuses a member who is not an org admin by name, and writes nothing', async () => {
    const got = await api(w.member, 'PUT', entry('agent-is-the-voice'), { title: 'Voice', body: RULING });
    expect(got.status).toBe(403);
    expect(JSON.stringify(got.body)).toMatch(/org\.admin|FORBIDDEN|PERMISSION/);
    expect((await api(w.admin, 'GET', entry('agent-is-the-voice'))).status).toBe(404);
  });

  it("reaches every project of the org, ahead of the project's own always-on entries", async () => {
    const put = await api(w.admin, 'PUT', entry('agent-is-the-voice'), { title: 'Voice', body: RULING });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ orgId: w.orgId, slug: 'agent-is-the-voice', injection: 'always' });
    const own = await api(w.admin, 'PUT', `/api/projects/${w.projectId}/knowledge/build-commands`, {
      kind: 'rule',
      title: 'Build',
      body: 'Build with pnpm build.',
      injection: 'always',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const preamble = await preambleOf(w.projectId);
    expect(preamble).toContain(RULING);
    expect(preamble.indexOf(RULING)).toBeLessThan(preamble.indexOf('Build with pnpm build.'));
    expect(await preambleOf(w.otherId)).toContain(RULING);
    expect(await servedCheckoutOrientation(w.projectId, w.slug)).toContain(RULING);
  });

  it("gives way to a project entry under the same slug, in that project only", async () => {
    const narrowed = 'Here the channel agent may post the release line itself.';
    const own = await api(w.admin, 'PUT', `/api/projects/${w.projectId}/knowledge/agent-is-the-voice`, {
      kind: 'rule',
      title: 'Voice here',
      body: narrowed,
      injection: 'always',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const preamble = await preambleOf(w.projectId);
    expect(preamble).toContain(narrowed);
    expect(preamble).not.toContain(RULING);
    expect(await preambleOf(w.otherId)).toContain(RULING);
  });

  it('is removed by its admin, and an entry it does not hold is refused by name', async () => {
    const gone = await api(w.admin, 'DELETE', entry('agent-is-the-voice'));
    expect(gone.status).toBe(200);
    expect(await preambleOf(w.otherId)).not.toContain(RULING);
    const again = await api(w.admin, 'DELETE', entry('agent-is-the-voice'));
    expect(again.status).toBe(404);
    expect(JSON.stringify(again.body)).toContain('ORG_KNOWLEDGE_NOT_FOUND');
    const bad = await api(w.admin, 'PUT', entry('Not_A_Slug'), { title: 't', body: 'b' });
    expect(bad.status).toBe(400);
  });
});
