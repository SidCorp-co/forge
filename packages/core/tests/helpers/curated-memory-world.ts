// The world the curated-memory e2e files share (REQ-89): a project with an admin on a throwaway
// Postgres, the memory and knowledge doors it writes through, and a write that answers all four
// curation questions. Each file mocks the embedder itself, since a mock is hoisted only in its file.

import { beforeAll } from 'vitest';
import { api, type Body, userToken } from './api.js';
import { addProjectMember, createTestProject, createTestUser } from './factories.js';

/** What the world holds once it is open; read through it, never copied before `beforeAll` ran. */
export const w = { projectId: '', orgId: '', token: '', userId: '' };

/** Opens the world before the file's cases: a verified admin on a project of their own. */
export function openCuratedMemoryWorld(): void {
  beforeAll(async () => {
    const user = await createTestUser({ verified: true });
    const project = await createTestProject(user.id);
    await addProjectMember(project.id, user.id, 'admin');
    w.projectId = project.id;
    w.orgId = project.orgId;
    w.userId = user.id;
    w.token = await userToken(user.id);
  });
}

export const write = (body: Body) =>
  api(w.token, 'POST', '/api/memory', { projectId: w.projectId, ...body });
export const entries = async (query = '') => {
  const res = await api(w.token, 'GET', `/api/memory/entries?projectId=${w.projectId}${query}`);
  return res;
};
export const putKnowledge = (slug: string, body: Body) =>
  api(w.token, 'PUT', `/api/projects/${w.projectId}/knowledge/${slug}`, body);
export const getKnowledge = (slug: string) =>
  api(w.token, 'GET', `/api/projects/${w.projectId}/knowledge/${slug}`);

/** A write answering value, type, scope and re-check, so it is kept as written. */
export const CURATED = {
  value: 'the next run touching the indexer knows why a vector is reused',
  type: 'fact',
  scope: 'every memory write of this project',
  recheckWhen: 'packages/core/src/memory/indexer.ts changes, or POST /api/memory',
};
