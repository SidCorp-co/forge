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
const findProjectName = vi.fn();
vi.mock('./read-service.js', () => ({
  findIssueById: (...a: unknown[]) => findIssueById(...a),
  findIssueByDisplaySeq: (...a: unknown[]) => findIssueByDisplaySeq(...a),
  findProjectName: (...a: unknown[]) => findProjectName(...a),
}));

const heldIssuePrefixes = vi.fn();
vi.mock('./issue-prefix-read.js', () => ({
  heldIssuePrefixes: (...a: unknown[]) => heldIssuePrefixes(...a),
}));

const loadProjectAccess = vi.fn();
const effectiveProjectRole = vi.fn();
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: (...a: unknown[]) => loadProjectAccess(...a),
  effectiveProjectRole: (...a: unknown[]) => effectiveProjectRole(...a),
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
  findProjectName.mockImplementation(async (id: string) =>
    id === PROJECT_ID ? 'Vault' : id === OTHER_PROJECT_ID ? 'Desk' : null,
  );
});

/** What a refusal says and carries, for the assertions below. */
async function refusalOf(run: Promise<unknown>) {
  try {
    await run;
  } catch (err) {
    const e = err as {
      status: number;
      message: string;
      cause?: { code?: string; details?: unknown };
    };
    return { status: e.status, message: e.message, code: e.cause?.code, details: e.cause?.details };
  }
  throw new Error('the read was not refused');
}

describe('resolveIssueRouteRef — the refusal names the project (ISS-1229 r41)', () => {
  const ORG_MEMBER_ONLY = { ...NO_ACCESS, orgRole: 'member' };
  const DESK_MEMBER = {
    projectId: OTHER_PROJECT_ID,
    orgId: 'org-1',
    role: 'member',
    orgRole: 'member',
  };
  const DESK_UNSEEN = { projectId: OTHER_PROJECT_ID, orgId: 'org-2', role: null, orgRole: null };

  it("names the issue's project to a member of its organization, and the project the address named", async () => {
    findIssueById.mockResolvedValueOnce({ id: ISSUE_UUID, projectId: PROJECT_ID });
    loadProjectAccess.mockResolvedValueOnce(ORG_MEMBER_ONLY);
    effectiveProjectRole.mockResolvedValueOnce(DESK_MEMBER);

    const r = await refusalOf(resolveIssueRouteRef(ISSUE_UUID, OTHER_PROJECT_ID, USER_ID));

    expect(r).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(r.message).toBe(
      'This issue belongs to Vault, a project you are not a member of. It is not in Desk, the project this address names.',
    );
    expect(r.details).toEqual({
      issueProject: { name: 'Vault' },
      addressProject: { id: OTHER_PROJECT_ID, name: 'Desk' },
    });
  });

  it("calls the issue's project 'a project you are not a member of' to a caller outside its organization", async () => {
    findIssueById.mockResolvedValueOnce({ id: ISSUE_UUID, projectId: PROJECT_ID });
    loadProjectAccess.mockResolvedValueOnce(NO_ACCESS);
    effectiveProjectRole.mockResolvedValueOnce(DESK_MEMBER);

    const r = await refusalOf(resolveIssueRouteRef(ISSUE_UUID, OTHER_PROJECT_ID, USER_ID));

    expect(r.message).toBe(
      'This issue belongs to a project you are not a member of. It is not in Desk, the project this address names.',
    );
    expect(r.message).not.toMatch(/Vault/);
    expect(r.details).toEqual({
      issueProject: { name: null },
      addressProject: { id: OTHER_PROJECT_ID, name: 'Desk' },
    });
  });

  // ISS-1229 r42, judge-118: the "not in" sentence was dropped only where the address named the issue's
  // own project, so a caller holding an issue's uuid could try project ids until it went quiet.
  it('says the same refusal whatever project the address names, to a caller with no role on it', async () => {
    const DESK_ORG_ONLY = { ...DESK_MEMBER, role: null };
    findIssueById.mockResolvedValue({ id: ISSUE_UUID, projectId: PROJECT_ID });
    loadProjectAccess.mockResolvedValue(ORG_MEMBER_ONLY);
    effectiveProjectRole.mockImplementation(async (_user: string, id: string) =>
      id === PROJECT_ID ? ORG_MEMBER_ONLY : id === OTHER_PROJECT_ID ? DESK_ORG_ONLY : DESK_UNSEEN,
    );

    const answers = [];
    for (const named of [
      undefined,
      PROJECT_ID,
      OTHER_PROJECT_ID,
      '33333333-3333-4333-8333-333333333333',
    ]) {
      answers.push(await refusalOf(resolveIssueRouteRef(ISSUE_UUID, named, USER_ID)));
    }
    for (const r of answers) {
      expect(r).toEqual({
        status: 403,
        code: 'FORBIDDEN',
        message: 'This issue belongs to Vault, a project you are not a member of.',
        details: { issueProject: { name: 'Vault' }, addressProject: null },
      });
    }
  });

  it('never names, or speaks of, an address project the caller may not see', async () => {
    findIssueById.mockResolvedValueOnce({ id: ISSUE_UUID, projectId: PROJECT_ID });
    loadProjectAccess.mockResolvedValueOnce(NO_ACCESS);
    effectiveProjectRole.mockResolvedValueOnce(DESK_UNSEEN);

    const r = await refusalOf(resolveIssueRouteRef(ISSUE_UUID, OTHER_PROJECT_ID, USER_ID));

    expect(r.message).toBe('This issue belongs to a project you are not a member of.');
    expect(r.details).toEqual({ issueProject: { name: null }, addressProject: null });
    expect(JSON.stringify(r)).not.toMatch(/Desk|Vault/);
  });

  it("says no address sentence where the read named no project, or named the issue's own", async () => {
    findIssueById.mockResolvedValue({ id: ISSUE_UUID, projectId: PROJECT_ID });
    loadProjectAccess.mockResolvedValue(ORG_MEMBER_ONLY);
    effectiveProjectRole.mockResolvedValue(ORG_MEMBER_ONLY);

    for (const named of [undefined, PROJECT_ID]) {
      const r = await refusalOf(resolveIssueRouteRef(ISSUE_UUID, named, USER_ID));
      expect(r.message).toBe('This issue belongs to Vault, a project you are not a member of.');
      expect(r.details).toEqual({ issueProject: { name: 'Vault' }, addressProject: null });
    }
  });

  it('refuses a display key under a closed project by naming that project as the caller may see it', async () => {
    effectiveProjectRole.mockResolvedValueOnce(ORG_MEMBER_ONLY);
    const seen = await refusalOf(resolveIssueRouteRef('ISS-4', PROJECT_ID, USER_ID));
    expect(seen.message).toBe(
      'Vault is a project you are not a member of, so none of its issues can be read.',
    );

    effectiveProjectRole.mockResolvedValueOnce(NO_ACCESS);
    const unseen = await refusalOf(resolveIssueRouteRef('ISS-4', PROJECT_ID, USER_ID));
    expect(unseen.message).toBe(
      'This address names no project you are a member of, so none of its issues can be read.',
    );
    expect(unseen.details).toEqual({ issueProject: { name: null }, addressProject: null });
  });

  // ISS-1229 r43, judge-120: an id that is no project answered 404 "Project not found" where another
  // organization's project answered 403, which told a caller whether a uuid is a project.
  it('refuses a display key under an id that is no project exactly as under a project it may not see', async () => {
    const UNSEEN = { projectId: PROJECT_ID, orgId: 'org-2', role: null, orgRole: null };
    effectiveProjectRole.mockResolvedValueOnce(UNSEEN);
    const another = await refusalOf(resolveIssueRouteRef('ISS-1', PROJECT_ID, USER_ID));
    effectiveProjectRole.mockResolvedValueOnce(null);
    const none = await refusalOf(resolveIssueRouteRef('ISS-1', OTHER_PROJECT_ID, USER_ID));

    expect(none).toEqual(another);
    expect(none).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(none.details).toEqual({ issueProject: { name: null }, addressProject: null });
    expect(none.message).not.toMatch(/Vault|Desk|not found/);
    expect(findIssueByDisplaySeq).not.toHaveBeenCalled();
  });
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
    effectiveProjectRole.mockResolvedValueOnce(MEMBER_ACCESS);
    findIssueByDisplaySeq.mockResolvedValueOnce({ id: ISSUE_UUID, projectId: PROJECT_ID });

    const issue = await resolveIssueRouteRef('ISS-1097', PROJECT_ID, USER_ID);

    expect(issue).toEqual({ id: ISSUE_UUID, projectId: PROJECT_ID });
    expect(findIssueByDisplaySeq).toHaveBeenCalledWith(PROJECT_ID, 1097);
  });

  it('a bare sequence number resolves the same as its legacy-prefixed key', async () => {
    effectiveProjectRole.mockResolvedValueOnce(MEMBER_ACCESS);
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
    expect(effectiveProjectRole).not.toHaveBeenCalled();
    expect(findIssueByDisplaySeq).not.toHaveBeenCalled();
  });

  it('refuses a string that is neither a uuid nor a key, carrying an example of each — no project asked first', async () => {
    await expect(resolveIssueRouteRef('##nope##', undefined, USER_ID)).rejects.toMatchObject({
      status: 400,
    });
    try {
      await resolveIssueRouteRef('##nope##', undefined, USER_ID);
      throw new Error('unreachable');
    } catch (err) {
      const details = (err as { cause?: { details?: { formErrors?: string[] } } }).cause?.details;
      const message = details?.formErrors?.join(' ') ?? '';
      expect(message).toMatch(/ISS-\d+/);
      expect(message).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
    expect(effectiveProjectRole).not.toHaveBeenCalled();
  });

  it('refuses a malformed identifier even when a project IS given — it never reaches the lookup', async () => {
    await expect(resolveIssueRouteRef('##nope##', PROJECT_ID, USER_ID)).rejects.toMatchObject({
      status: 400,
    });
    expect(effectiveProjectRole).not.toHaveBeenCalled();
  });

  it('refuses a key on a project the caller cannot read — 403, asserted BEFORE the key is looked up', async () => {
    effectiveProjectRole.mockResolvedValueOnce(NO_ACCESS);

    await expect(resolveIssueRouteRef('ISS-1097', PROJECT_ID, USER_ID)).rejects.toMatchObject({
      status: 403,
    });
    expect(findIssueByDisplaySeq).not.toHaveBeenCalled();
  });

  it('refuses a `projectId` that is not itself a uuid — 400', async () => {
    await expect(resolveIssueRouteRef('ISS-1097', 'not-a-uuid', USER_ID)).rejects.toMatchObject({
      status: 400,
    });
    expect(effectiveProjectRole).not.toHaveBeenCalled();
  });

  it('answers 404 naming the KEY, never the uuid the request never sent, when the project holds nothing there', async () => {
    effectiveProjectRole.mockResolvedValueOnce(MEMBER_ACCESS);
    findIssueByDisplaySeq.mockResolvedValueOnce(null);

    await expect(resolveIssueRouteRef('ISS-1097', PROJECT_ID, USER_ID)).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('ISS-1097'),
    });
  });

  it('a key naming an issue in a DIFFERENT project than the one named is 404 there, not a cross-project hit', async () => {
    effectiveProjectRole.mockResolvedValueOnce(MEMBER_ACCESS);
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

  it('refuses a malformed identifier — 400, carrying an example of each shape', async () => {
    await expect(resolveIssueKeyInProject('##nope##', PROJECT_ID)).rejects.toMatchObject({
      status: 400,
    });
    try {
      await resolveIssueKeyInProject('##nope##', PROJECT_ID);
      throw new Error('unreachable');
    } catch (err) {
      const details = (err as { cause?: { details?: { formErrors?: string[] } } }).cause?.details;
      const message = details?.formErrors?.join(' ') ?? '';
      expect(message).toMatch(/ISS-\d+/);
      expect(message).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });
});
