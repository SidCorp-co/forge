import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

let queuedResults: Row[][] = [];
const selectSpy = vi.fn();

vi.mock('../db/client.js', () => {
  const chain: Record<string, unknown> = {};
  chain.select = (...args: unknown[]) => {
    selectSpy(...args);
    return chain;
  };
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.limit = async (_n: number) => queuedResults.shift() ?? [];
  return { db: chain };
});

const { assertUserIsProjectMember, assertUserIsProjectOwner } = await import('./policy.js');

type Ctx = Parameters<typeof assertUserIsProjectMember>[0];

function makeCtx(userId: string): Ctx {
  const vars = new Map<string, unknown>([
    ['user', { id: userId, email: 'x@y', emailVerifiedAt: null }],
  ]);
  return {
    get: (k: string) => vars.get(k),
  } as unknown as Ctx;
}

async function expectForbidden(p: Promise<void>) {
  await expect(p).rejects.toMatchObject({
    status: 403,
    cause: { code: 'FORBIDDEN' },
  });
  await p.catch((e) => {
    expect(e).toBeInstanceOf(HTTPException);
  });
}

beforeEach(() => {
  queuedResults = [];
  selectSpy.mockClear();
});

describe('assertUserIsProjectMember', () => {
  it('resolves when a membership row exists', async () => {
    queuedResults = [[{ userId: 'user-1' }]];
    await expect(assertUserIsProjectMember(makeCtx('user-1'), 'proj-1')).resolves.toBeUndefined();
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('throws 403 FORBIDDEN when no membership row exists', async () => {
    queuedResults = [[]];
    await expectForbidden(assertUserIsProjectMember(makeCtx('user-1'), 'proj-1'));
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('issues exactly one query (no N+1)', async () => {
    queuedResults = [[{ userId: 'user-1' }]];
    await assertUserIsProjectMember(makeCtx('user-1'), 'proj-1');
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });
});

describe('assertUserIsProjectOwner', () => {
  it('resolves when the project row matches (ownerId or role=owner)', async () => {
    queuedResults = [[{ projectId: 'proj-1' }]];
    await expect(assertUserIsProjectOwner(makeCtx('user-1'), 'proj-1')).resolves.toBeUndefined();
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('throws 403 FORBIDDEN when the user is only a non-owner member', async () => {
    queuedResults = [[]];
    await expectForbidden(assertUserIsProjectOwner(makeCtx('user-1'), 'proj-1'));
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('throws 403 FORBIDDEN when the user has no relationship to the project', async () => {
    queuedResults = [[]];
    await expectForbidden(assertUserIsProjectOwner(makeCtx('stranger'), 'proj-1'));
  });

  it('issues exactly one query (no N+1)', async () => {
    queuedResults = [[{ projectId: 'proj-1' }]];
    await assertUserIsProjectOwner(makeCtx('user-1'), 'proj-1');
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });
});
