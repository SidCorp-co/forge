/**
 * ISS-861: a ruling written as project knowledge reached only the project that wrote it, so every
 * other project went on as before. An organisation's always-on entry now reaches the prompt of every
 * project in the org, ahead of the project's own; a project entry under the same slug takes its
 * place; and only an org admin writes one, a member refused by name. Against real Postgres.
 *
 * @direct-test-of packages/core/src/knowledge/org-knowledge.ts
 * @direct-test-of packages/core/src/knowledge/org-knowledge-routes.ts
 * @direct-test-of packages/core/src/knowledge/service.ts
 * @direct-test-of packages/core/src/prompt/facts/guide-index.ts
 *
 * ISS-867: an org's on-demand entry is named in its projects' guide index and read by their agents
 * through the project's own knowledge door, which a project member reaches with no org access.
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { servedCheckoutOrientation } from '../../src/prompt/checkout-orientation.js';
import { loadProjectFactInputs, renderStageFactsText } from '../../src/prompt/facts/resolve.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

const RULING = 'The agent is the only voice: core composes no words a person reads.';
// what every entry rests on, where it applies and when it needs re-checking (ISS-1064)
const SOURCED = {
  source: 'owner ruling 2026-11-01, ISS-861',
  scope: 'every project of the org',
  recheckWhen: 'the owner rules again on who speaks',
};
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
    const got = await api(w.member, 'PUT', entry('agent-is-the-voice'), {
      title: 'Voice',
      body: RULING,
    });
    expect(got.status).toBe(403);
    expect(JSON.stringify(got.body)).toMatch(/org\.admin|FORBIDDEN|PERMISSION/);
    expect((await api(w.admin, 'GET', entry('agent-is-the-voice'))).status).toBe(404);
  });

  it("reaches every project of the org, ahead of the project's own always-on entries", async () => {
    const put = await api(w.admin, 'PUT', entry('agent-is-the-voice'), {
      title: 'Voice',
      body: RULING,
      ...SOURCED,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({
      orgId: w.orgId,
      slug: 'agent-is-the-voice',
      injection: 'always',
    });
    const own = await api(w.admin, 'PUT', `/api/projects/${w.projectId}/knowledge/build-commands`, {
      kind: 'rule',
      title: 'Build',
      body: 'Build with pnpm build.',
      injection: 'always',
      ...SOURCED,
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const preamble = await preambleOf(w.projectId);
    expect(preamble).toContain(RULING);
    expect(preamble.indexOf(RULING)).toBeLessThan(preamble.indexOf('Build with pnpm build.'));
    expect(await preambleOf(w.otherId)).toContain(RULING);
    expect(await servedCheckoutOrientation(w.projectId, w.slug)).toContain(RULING);
  });

  it('gives way to a project entry under the same slug, in that project only', async () => {
    const narrowed = 'Here the channel agent may post the release line itself.';
    const own = await api(
      w.admin,
      'PUT',
      `/api/projects/${w.projectId}/knowledge/agent-is-the-voice`,
      {
        kind: 'rule',
        title: 'Voice here',
        body: narrowed,
        injection: 'always',
        ...SOURCED,
      },
    );
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

  it("names an org's on-demand guide in its projects' prompts and lets a project member read it (ISS-867)", async () => {
    const guide = 'Release notes are written for the person reading them, never for the team.';
    const put = await api(w.admin, 'PUT', entry('release-notes-voice'), {
      title: 'Release notes',
      body: guide,
      injection: 'on_demand',
      ...SOURCED,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const preamble = await preambleOf(w.otherId);
    expect(preamble).toContain('- release-notes-voice (org)');
    expect(preamble).not.toContain(guide);
    expect(await servedCheckoutOrientation(w.otherId, 'other')).toContain(
      '- release-notes-voice (org)',
    );
    // a project member with no org role reads it through the project's door, labelled as the org's
    const reader = await createTestUser({ verified: true });
    await addProjectMember(w.otherId, reader.id, 'member');
    const token = await userToken(reader.id);
    const read = await api(
      token,
      'GET',
      `/api/projects/${w.otherId}/knowledge/release-notes-voice`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ origin: 'org', body: guide, injection: 'on_demand' });
    expect((await api(token, 'GET', entry('release-notes-voice'))).status).toBe(403);
    // an entry neither holds is still a 404
    const none = await api(token, 'GET', `/api/projects/${w.otherId}/knowledge/no-such-guide`);
    expect(none.status).toBe(404);
    // a project entry under the slug takes the org's place, in that project's index and door
    const own = await api(
      w.admin,
      'PUT',
      `/api/projects/${w.projectId}/knowledge/release-notes-voice`,
      {
        kind: 'reference',
        title: 'Ours',
        body: 'Here notes are terse.',
        injection: 'on_demand',
        ...SOURCED,
        source: 'ISS-867',
      },
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const mine = await preambleOf(w.projectId);
    expect(mine).toMatch(/^- release-notes-voice — source: ISS-867$/m);
    expect(mine).not.toContain('- release-notes-voice (org)');
    const ours = await api(
      w.admin,
      'GET',
      `/api/projects/${w.projectId}/knowledge/release-notes-voice`,
    );
    expect(ours.body).toMatchObject({ origin: 'project', body: 'Here notes are terse.' });
    // a project of another org reads none of it
    const stranger = await createTestProject(reader.id);
    const away = await api(
      token,
      'GET',
      `/api/projects/${stranger.id}/knowledge/release-notes-voice`,
    );
    expect(away.status).toBe(404);
  });
});
