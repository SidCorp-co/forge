import { OUTBOX_CONSUMERS } from '@forge/contracts/outbox-consumers';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  notices: [] as Record<string, unknown>[],
  resolved: [] as [string, string | undefined][],
}));

vi.mock('./emit.js', () => ({
  emitNotification: async (n: Record<string, unknown>) => {
    state.notices.push(n);
    return { id: 'n1', delivered: 1 };
  },
}));
vi.mock('./auto-resolve.js', () => ({
  resolveNotifications: async (key: string, outcome?: string) => {
    state.resolved.push([key, outcome]);
    return 1;
  },
}));

const { consumerOf } = await import('../outbox/consumers.js');
const { registerFeedbackNotifications } = await import('./notify-feedback.js');

describe('feedback-triage verify-ask: the ask reaches the reporter', () => {
  beforeAll(() => registerFeedbackNotifications());

  it('is declared on the outbox', () => {
    expect(OUTBOX_CONSUMERS['feedback.verifyAsked']).toContain('notify-feedback');
    expect(OUTBOX_CONSUMERS['feedback.verifySettled']).toContain('notify-feedback');
  });

  it("sends the ask to the reporter's bell and nobody else", async () => {
    await consumerOf('feedback.verifyAsked', 'notify-feedback')?.handle(
      { projectId: 'p1', feedbackId: 'f1', key: 'FB-4', title: 'Export breaks', reporter: 'u-rep' },
      { eventId: 'e1' } as never,
    );
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toMatchObject({
      recipients: ['u-rep'],
      projectId: 'p1',
      type: 'feedback_verify_asked',
      resolutionKey: 'feedback-verify:f1',
      dedupeKey: 'feedback-verify-ask:e1',
    });
    expect(String(state.notices[0]?.title)).toContain('FB-4');
  });

  it('settles the ask when the item is verified or reopened', async () => {
    await consumerOf('feedback.verifySettled', 'notify-feedback')?.handle(
      { projectId: 'p1', feedbackId: 'f1', key: 'FB-4', decision: 'reopened' },
      {} as never,
    );
    expect(state.resolved).toEqual([['feedback-verify:f1', 'FB-4 reopened']]);
  });
});
