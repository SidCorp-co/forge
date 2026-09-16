// The drizzle chain mock the two `forge_feedback` suites share, plus the ids and the row-queueing
// helpers they both file against. It is a factory and not a module of singletons so each suite
// owns its own mocks: vitest isolates files, not module state within a worker.

import { type Mock, vi } from 'vitest';
import { makeFakeJobPrincipal } from '../fake-principal.fixture.js';

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const PROJECT_SLUG = 'forge-dev';
export const PROJECT_ID_2 = '22222222-2222-4222-8222-222222222222';
export const OWNER_ID = '33333333-3333-4333-8333-333333333333';
export const TOKEN_ID = '99999999-9999-4999-8999-99999999aaaa';
export const JOB_ID = '55555555-5555-4555-8555-555555555555';
export const RUN_ID = '66666666-6666-4666-8666-666666666666';
export const ISSUE_ID = '77777777-7777-4777-8777-777777777777';
export const ORG_ID = '99999999-9999-4999-8999-999999999999';
export const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

export const memberAccessRow = { orgId: ORG_ID, memberRole: 'member', orgRole: null };

const jobPrincipal = makeFakeJobPrincipal(TOKEN_ID, OWNER_ID, DEVICE_ID, PROJECT_ID);

export function makeCtx(projectSlug = PROJECT_SLUG) {
  return { principal: jobPrincipal, projectSlug };
}

export interface FeedbackDbMocks {
  db: { select: Mock; selectDistinct: Mock; insert: Mock; update: Mock };
  selectLimit: Mock;
  selectOrderBy: Mock;
  selectWhere: Mock;
  selectFrom: Mock;
  insertValues: Mock;
  insertReturning: Mock;
  updateSet: Mock;
  updateWhere: Mock;
  updateReturning: Mock;
  dbSelect: Mock;
  dbInsert: Mock;
  dbUpdate: Mock;
  selectDistinctWhere: Mock;
  install: () => void;
  queueSlugAndMember: (...then: unknown[][]) => void;
  queueMemberOnly: (...then: unknown[][]) => void;
  mockVisibleProjects: (ids: string[]) => void;
}

export function makeFeedbackDbMocks(): FeedbackDbMocks {
  const selectLimit = vi.fn();
  const selectOrderBy = vi.fn();
  const selectWhere = vi.fn();
  const selectInnerJoin = vi.fn();
  const selectLeftJoin2 = vi.fn();
  const selectLeftJoin = vi.fn();
  const selectFrom = vi.fn();
  const insertReturning = vi.fn();
  const insertValues = vi.fn();
  const updateReturning = vi.fn();
  const updateWhere = vi.fn();
  const updateSet = vi.fn();
  const dbSelect = vi.fn();
  const dbInsert = vi.fn();
  const dbUpdate = vi.fn();
  const selectDistinctWhere = vi.fn();
  const selectDistinctLeftJoin2 = vi.fn();
  const selectDistinctLeftJoin = vi.fn();
  const selectDistinctFrom = vi.fn();
  const dbSelectDistinct = vi.fn();

  function install(): void {
    selectFrom.mockImplementation(() => ({
      where: selectWhere,
      leftJoin: selectLeftJoin,
      innerJoin: selectInnerJoin,
    }));
    selectWhere.mockImplementation(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
    selectOrderBy.mockImplementation(() => ({ limit: selectLimit }));
    selectLeftJoin.mockImplementation(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
    selectLeftJoin2.mockImplementation(() => ({ where: selectWhere }));
    selectInnerJoin.mockImplementation(() => ({ where: selectWhere }));
    insertValues.mockImplementation(() => ({ returning: insertReturning }));
    updateSet.mockImplementation(() => ({ where: updateWhere }));
    updateWhere.mockImplementation(() => ({ returning: updateReturning }));
    dbSelect.mockImplementation(() => ({ from: selectFrom }));
    dbInsert.mockImplementation(() => ({ values: insertValues }));
    dbUpdate.mockImplementation(() => ({ set: updateSet }));
    selectDistinctLeftJoin2.mockImplementation(() => ({ where: selectDistinctWhere }));
    selectDistinctLeftJoin.mockImplementation(() => ({ leftJoin: selectDistinctLeftJoin2 }));
    selectDistinctFrom.mockImplementation(() => ({ leftJoin: selectDistinctLeftJoin }));
    dbSelectDistinct.mockImplementation(() => ({ from: selectDistinctFrom }));
  }
  install();

  /** resolveProjectIdFromSlug then effectiveProjectRole — the two reads every action makes first, plus any rows the action reads after them. */
  function queueSlugAndMember(...then: unknown[][]): void {
    let m = selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    for (const rows of [[memberAccessRow], ...then]) m = m.mockResolvedValueOnce(rows);
  }

  /** `submit` names its project, so it spends no slug lookup — only the membership check. */
  function queueMemberOnly(...then: unknown[][]): void {
    let m = selectLimit.mockResolvedValueOnce([memberAccessRow]);
    for (const rows of then) m = m.mockResolvedValueOnce(rows);
  }

  function mockVisibleProjects(ids: string[]): void {
    selectDistinctWhere.mockResolvedValueOnce(ids.map((id) => ({ id })));
  }

  return {
    db: { select: dbSelect, selectDistinct: dbSelectDistinct, insert: dbInsert, update: dbUpdate },
    selectLimit,
    selectOrderBy,
    selectWhere,
    selectFrom,
    insertValues,
    insertReturning,
    updateSet,
    updateWhere,
    updateReturning,
    dbSelect,
    dbInsert,
    dbUpdate,
    selectDistinctWhere,
    install,
    queueSlugAndMember,
    queueMemberOnly,
    mockVisibleProjects,
  };
}
