import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test' },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// emitPipelineWedge issues exactly two select()s in order: the resolutionKey
// dedupe check, then the project owner lookup. Queue results in call order.
const selectResults: Array<Array<unknown>> = [];
const selectLimit = vi.fn(async () => selectResults.shift() ?? []);
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: selectFrom }),
  },
}));

const createNotificationMock = vi.fn(async (..._args: unknown[]) => ({ id: 'notif-1' }));
vi.mock('../notifications/routes.js', () => ({
  createNotification: (...args: unknown[]) => createNotificationMock(...(args as [])),
}));

const { emitPipelineWedge } = await import('./wedge.js');

const BASE_EVENT = {
  projectId: 'proj-1',
  issueId: 'issue-1',
  hop: 'dispatch' as const,
  entity: 'job' as const,
  entityId: 'job-1',
  reason: 'technical why',
  action: 'technical what',
};

beforeEach(() => {
  vi.clearAllMocks();
  selectResults.length = 0;
  selectResults.push([], [{ createdBy: 'owner-1' }]);
});

describe('emitPipelineWedge (ISS-619)', () => {
  it('dedupes via resolutionKey, not a body marker', async () => {
    await emitPipelineWedge(BASE_EVENT);
    expect(selectWhere).toHaveBeenCalled();
    expect(createNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ resolutionKey: 'wedge:job-1' }),
    );
    const call = createNotificationMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.body).not.toContain('[entity:');
  });

  it('skips when an unread wedge for the entity already exists', async () => {
    selectResults[0] = [{ id: 'existing' }];
    await emitPipelineWedge(BASE_EVENT);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('uses the business-language title/summary/nextStep when supplied, and drops technical vocab', async () => {
    await emitPipelineWedge({
      ...BASE_EVENT,
      title: 'Blocked: ISS-27 "Widget i18n" is waiting on a blocking issue that can\'t continue',
      summary: 'Waiting ~2h. ISS-31 "Translate onboarding copy" is parked at "Needs info".',
      nextStep: 'Add the missing info to ISS-31.',
      secondaryIssueId: 'issue-31',
    });
    const call = createNotificationMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.title).not.toContain('hop miss');
    expect(call.body).toBe(
      'Waiting ~2h. ISS-31 "Translate onboarding copy" is parked at "Needs info".\nNext: Add the missing info to ISS-31.',
    );
    expect(call.secondaryIssueId).toBe('issue-31');
  });

  it('falls back to the technical WHERE/WHY/WHAT template when no presentation fields are given', async () => {
    await emitPipelineWedge(BASE_EVENT);
    const call = createNotificationMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.title).toBe('Pipeline wedge: dispatch hop miss on job');
    expect(call.body).toContain('WHY: technical why');
    expect(call.body).toContain('WHAT: technical what');
    expect(call.secondaryIssueId).toBeNull();
  });
});
