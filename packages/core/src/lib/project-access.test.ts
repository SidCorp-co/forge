import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const limit = vi.fn();
const where = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));

vi.mock('../db/client.js', () => ({
  db: { select },
}));

const { assertProjectMemberAccess } = await import('./project-access.js');

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STRANGER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

beforeEach(() => {
  limit.mockReset();
});

describe('assertProjectMemberAccess', () => {
  it('passes when caller is the project owner (short-circuits member lookup)', async () => {
    limit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    await expect(assertProjectMemberAccess(PROJECT_ID, OWNER_ID)).resolves.toBeUndefined();
    // Only 1 lookup — never queries projectMembers when owner matches.
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('passes when caller is a project member (not owner)', async () => {
    limit
      .mockResolvedValueOnce([{ ownerId: OWNER_ID }])
      .mockResolvedValueOnce([{ userId: MEMBER_ID }]);
    await expect(assertProjectMemberAccess(PROJECT_ID, MEMBER_ID)).resolves.toBeUndefined();
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it('throws 403 when caller is neither owner nor member', async () => {
    limit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]).mockResolvedValueOnce([]);
    await expect(assertProjectMemberAccess(PROJECT_ID, STRANGER_ID)).rejects.toMatchObject({
      status: 403,
      message: 'not a project member',
    });
  });

  it('throws 403 with the same message when project does not exist (no existence leak)', async () => {
    limit.mockResolvedValueOnce([]);
    const err = await assertProjectMemberAccess(PROJECT_ID, STRANGER_ID).catch((e) => e);
    expect(err).toBeInstanceOf(HTTPException);
    expect(err.status).toBe(403);
    expect(err.message).toBe('not a project member');
  });
});
