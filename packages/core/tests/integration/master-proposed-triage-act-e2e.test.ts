/**
 * ISS-1273 (FB-701): a master's wake named a feedback item carrying a proposed `feedback_triage` as
 * "yours to decide" and sent it to `suggestions/<id>/accept`, which takes suggestions.approve, a
 * permission a master credential (a member writing the project) does not hold: every accept was
 * refused and the suggestion went stale. The wake now names the accept only where the master's own
 * account holds what the accept door checks, says to route the item itself where it holds only what
 * routing takes, and leaves the item out where it holds neither. No grant is widened.
 *
 * @direct-test-of packages/core/src/masters/owed-triages.ts
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/execution-ports.ts
 * @direct-test-of packages/core/src/steward/ask-addressee.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readMasterWork } from '../../src/masters/owed.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { pairTestBox } from '../helpers/paired-box.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

let projectId = '';
let ownerToken = '';
let masterId = '';
let key = '';
let suggestion = '';

beforeEach(async () => {
  await truncateAll();
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  ownerToken = await userToken(ownerId);
  masterId = (await createTestUser({ kind: 'agent' })).id;
  key = await createTestFeedback(projectId, ownerId, 1);
  const proposed = await api(ownerToken, 'POST', `/api/projects/${projectId}/suggestions`, {
    kind: 'feedback_triage',
    feedback: key,
    baseRevision: null,
    payload: { route: 'issue', createIssue: {}, answers: TRIAGE_ANSWERS, note: 'the filter' },
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  suggestion = (proposed.body as { suggestion: { id: string } }).suggestion.id;
}, 120_000);

/** The master's wake, as the box serving it reads it, and the pane credential that box writes under. */
async function wakeOf(role: 'member' | 'admin', actsAs: string | null) {
  await addProjectMember(projectId, masterId, role);
  const box = await pairTestBox(projectId, { pairedBy: masterId, actsAs });
  const { work } = await readMasterWork(box.deviceId, projectId);
  return { line: work.owedLine, paneToken: box.paneToken };
}

const ACCEPT = 'suggestions/<id>/accept';

describe('a proposed feedback triage on a master’s wake (ISS-1273)', () => {
  it('is never offered to accept by a master that cannot, which is told to route the item itself', async () => {
    const { line, paneToken } = await wakeOf('member', masterId);
    expect(line).not.toContain(ACCEPT);
    expect(line).not.toContain('yours to decide');
    expect(line).toContain(
      `your credential cannot accept (it holds no suggestions.approve) (${key} suggestion ${suggestion})`,
    );
    expect(line).toContain('feedback/<key>/triage -X POST');

    // no grant widened: that master's own credential is still refused the accept
    const accept = await api(
      paneToken as string,
      'POST',
      `/api/projects/${projectId}/suggestions/${suggestion}/accept`,
      {},
    );
    expect(accept.status, JSON.stringify(accept.body)).toBe(403);
    expect(JSON.stringify(accept.body)).toContain('suggestions.approve');
  });

  it('is offered to accept where the master’s own account holds suggestions.approve', async () => {
    const { line } = await wakeOf('admin', masterId);
    expect(line).toContain(`yours to decide (${key} suggestion ${suggestion})`);
    expect(line).toContain(ACCEPT);
  });

  it('is left out where the account the master acts as cannot be read, waiting on whoever can', async () => {
    const { line } = await wakeOf('admin', null);
    expect(line).not.toContain(suggestion);
    expect(line).not.toContain(ACCEPT);
  });
});
