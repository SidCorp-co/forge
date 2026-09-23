/**
 * ISS-1160 — `resolveIssueRouteRef` / `resolveIssueKeyInProject` are the one door every
 * issue-scoped REST read now resolves its `:id` through. `parseIssueRef` and
 * `findIssueByDisplaySeq` are exercised in their own suites (`lib/issue-ref.test.ts`,
 * `mcp/tools/issue-ref-input.test.ts`); this file owns what is new here — the uuid/key
 * fork, the project-scope requirement a bare-key caller now carries, and the order
 * access is asserted in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findIssueById = vi.fn();
const findIssueByDisplaySeq = vi.fn();
vi.mock('./read-service.js', () => ({
  findIssueById: (...a: unknown[]) => findIssueById(...a),
  findIssueByDisplaySeq: (...a: unknown[]) => findIssueByDisplaySeq(...a),
}));

const heldIssuePrefixes = vi.fn();
vi.mock('./issue-prefix-read.js', () => ({
  heldIssuePrefixes: (...a: unknown[]) => heldIssuePrefixes(...a),
}));

const loadProjectAccess = vi.fn();
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: (...a: unknown[]) => loadProjectAccess(...a),
}));

const { resolveIssueRouteRef, resolveIssueKeyInProject, isUuid } = await import(
  './issue-route-ref.js'
);

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT_ID = '99999999-9999-4999-8999-999999999999';
const ISSUE_UUID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-1';

const MEMBER_ACCESS = { projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null };
const NO_ACCESS = { projectId: PROJECT_ID, orgId: 'org-1', role: null, orgRole: null };

beforeEach(() => {
  vi.clearAllMocks();
  heldIssuePrefixes.mockResolvedValue([]);
});

describe('isUuid', () => {
  it('admits a uuid', () => {
    expect(isUuid(ISSUE_UUID)).toBe(true);
  });

  it('refuses a display key', () => {
    expect(isUuid('ISS-1097')).toBe(false);
  });
});

describe('resolveIssueRouteRef — happy path', () => {
  it('a uuid resolves as it always did: no project scope asked, access checked on the row', async () => {
    findIssueById.mockResolvedValueOnce({ id: ISSUE_UUID, projectId: PROJECT_ID });
    loadProjectAccess.mockResolvedValueOnce(MEMBER_ACCESS);

    const issue = await resolveIssueRouteRef(ISSUE_UUID, undefined, USER_ID);

    expect(issue).toEqual({ id: ISSUE_UUID, projectId: PROJECT_ID });
    expect(findIssueById).toHaveBeenCalledWith(ISSUE_UUID);
    expect(loadProjectAccess).toHaveBeenCalledWith(PROJECT_ID, USER_ID);
    expect(findIssueByDisplaySeq).not.toHaveBeenCalled();
  });

  it('a display key resolves the same row, scoped to the named project the caller can read', async () => {
    loadProjectAccess.mockResolvedValueOnce(MEMBER_ACCESS);
    findIssueByDisplaySeq.mockResolvedValueOnce({ id: ISSUE_UUID, projectId: PROJECT_ID });

    const issue = await resolveIssueRouteRef('ISS-1097', PROJECT_ID, USER_ID);

    expect(issue).toEqual({ id: ISSUE_UUID, projectId: PROJECT_ID });
    expect(findIssueByDisplaySeq).toHaveBeenCalledWith(PROJECT_ID, 1097);
  });

  it('a bare sequence number resolves the same as its legacy-prefixed key', async () => {
    loadProjectAccess.mockResolvedValueOnce(MEMBER_ACCESS);
    findIssueByDisplaySeq.mockResolvedValueOnce({ id: ISSUE_UUID, projectId: PROJECT_ID });

    const issue = await resolveIssueRouteRef('1097', PROJECT_ID, USER_ID);

    expect(issue.id).toBe(ISSUE_UUID);
    expect(findIssueByDisplaySeq).toHaveBeenCalledWith(PROJECT_ID, 1097);
  });
});

describe('resolveIssueRouteRef — the negative case is the whole point', () => {
  it('refuses a uuid naming no row — 404, never the generic uuid-shape 400', async () => {
    findIssueById.mockResolvedValueOnce(null);

    await expect(resolveIssueRouteRef(ISSUE_UUID, undefined, USER_ID)).rejects.toMatchObject({
      status: 404,
    });
    expect(loadProjectAccess).not.toHaveBeenCalled();
  });

  it('refuses a uuid on a project the caller cannot read — 403', async () => {
    findIssueById.mockResolvedValueOnce({ id: ISSUE_UUID, projectId: PROJECT_ID });
    loadProjectAccess.mockResolvedValueOnce(NO_ACCESS);

    await expect(resolveIssueRouteRef(ISSUE_UUID, undefined, USER_ID)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('refuses a display key with no project to scope it — 400, naming what is missing, not a uuid shape', async () => {
    await expect(resolveIssueRouteRef('ISS-1097', undefined, USER_ID)).rejects.toMatchObject({
      status: 400,
    });
    try {
      await resolveIssueRouteRef('ISS-1097', undefined, USER_ID);
      throw new Error('unreachable');
    } catch (err) {
      const details = (err as { cause?: { details?: { formErrors?: string[] } } }).cause?.details;
      expect(details?.formErrors?.join(' ')).toMatch(/projectId=/);
    }
    expect(loadProjectAccess).not.toHaveBeenCalled();
    expect(findIssueByDisplaySeq).not.toHaveBeenCalled();
  });

  it('refuses a string that is neither a uuid nor a key, carrying an example of each — no project asked first', async () => {
    await expect(resolveIssueRouteRef('##nope##', undefined, USER_ID)).rejects.toMatchObject({
      status: 400,
    });
    expect(loadProjectAccess).not.toHaveBeenCalled();
  });

  it('refuses a malformed identifier even when a project IS given — it never reaches the lookup', async () => {
    await expect(resolveIssueRouteRef('##nope##', PROJECT_ID, USER_ID)).rejects.toMatchObject({
      status: 400,
    });
    expect(loadProjectAccess).not.toHaveBeenCalled();
  });

  it('refuses a key on a project the caller cannot read — 403, asserted BEFORE the key is looked up', async () => {
    loadProjectAccess.mockResolvedValueOnce(NO_ACCESS);

    await expect(resolveIssueRouteRef('ISS-1097', PROJECT_ID, USER_ID)).rejects.toMatchObject({
      status: 403,
    });
    expect(findIssueByDisplaySeq).not.toHaveBeenCalled();
  });

  it('refuses a `projectId` that is not itself a uuid — 400', async () => {
    await expect(resolveIssueRouteRef('ISS-1097', 'not-a-uuid', USER_ID)).rejects.toMatchObject({
      status: 400,
    });
    expect(loadProjectAccess).not.toHaveBeenCalled();
  });

  it('answers 404 naming the KEY, never the uuid the request never sent, when the project holds nothing there', async () => {
    loadProjectAccess.mockResolvedValueOnce(MEMBER_ACCESS);
    findIssueByDisplaySeq.mockResolvedValueOnce(null);

    await expect(resolveIssueRouteRef('ISS-1097', PROJECT_ID, USER_ID)).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('ISS-1097'),
    });
  });

  it('a key naming an issue in a DIFFERENT project than the one named is 404 there, not a cross-project hit', async () => {
    loadProjectAccess.mockResolvedValueOnce(MEMBER_ACCESS);
    // The mock stands in for `issues_project_iss_seq_uq`: issSeq 1097 exists
    // only under OTHER_PROJECT_ID, so a lookup scoped to PROJECT_ID finds nothing.
    findIssueByDisplaySeq.mockImplementationOnce(async (projectId: string) =>
      projectId === OTHER_PROJECT_ID ? { id: ISSUE_UUID, projectId: OTHER_PROJECT_ID } : null,
    );

    await expect(resolveIssueRouteRef('ISS-1097', PROJECT_ID, USER_ID)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('resolveIssueKeyInProject — Layer A for a caller that already owns its project scope', () => {
  it('a uuid passes through untouched — no lookup, no held-prefix read', async () => {
    const id = await resolveIssueKeyInProject(ISSUE_UUID, PROJECT_ID);
    expect(id).toBe(ISSUE_UUID);
    expect(findIssueByDisplaySeq).not.toHaveBeenCalled();
  });

  it('a display key resolves to the row uuid inside the given project', async () => {
    findIssueByDisplaySeq.mockResolvedValueOnce({ id: ISSUE_UUID, projectId: PROJECT_ID });
    const id = await resolveIssueKeyInProject('ISS-1185', PROJECT_ID);
    expect(id).toBe(ISSUE_UUID);
    expect(findIssueByDisplaySeq).toHaveBeenCalledWith(PROJECT_ID, 1185);
  });

  it('refuses a key naming nothing in that project — 404, naming the key', async () => {
    findIssueByDisplaySeq.mockResolvedValueOnce(null);
    await expect(resolveIssueKeyInProject('ISS-1185', PROJECT_ID)).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('ISS-1185'),
    });
  });

  it('refuses a malformed identifier — 400, carrying an example', async () => {
    await expect(resolveIssueKeyInProject('##nope##', PROJECT_ID)).rejects.toMatchObject({
      status: 400,
    });
  });
});
