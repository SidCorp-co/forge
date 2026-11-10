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

vi.mock('../feedback/index.js', async () => {
  const { shippedNotice, verifyAskNotice } = await import('../feedback/reporter-notices.js');
  return { shippedNotice, verifyAskNotice };
});

const { consumerOf } = await import('../outbox/consumers.js');
const { registerFeedbackNotifications } = await import('./notify-feedback.js');

describe('feedback-triage verify-ask: the ask reaches the reporter', () => {
  beforeAll(() => registerFeedbackNotifications());

  it('is declared on the outbox', () => {
    expect(OUTBOX_CONSUMERS['feedback.reporterTold']).toContain('notify-feedback');
    expect(OUTBOX_CONSUMERS['feedback.verifyAsked']).toContain('notify-feedback');
    expect(OUTBOX_CONSUMERS['feedback.verifySettled']).toContain('notify-feedback');
    expect(OUTBOX_CONSUMERS['release.shipped']).toContain('notify-feedback');
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
    // ISS-857: the kernel fact, and no canned confirm-or-reopen ask; verify and reopen stay actions
    expect(state.notices[0]?.title).toBe('FB-4 · resolved · Export breaks');
    expect(state.notices[0]?.body ?? null).toBeNull();
  });

  it('settles the ask when the item is verified or reopened', async () => {
    await consumerOf('feedback.verifySettled', 'notify-feedback')?.handle(
      { projectId: 'p1', feedbackId: 'f1', key: 'FB-4', decision: 'reopened' },
      {} as never,
    );
    expect(state.resolved).toEqual([['feedback-verify:f1', 'FB-4 reopened']]);
  });
});

// ISS-1192: a move somebody else made on the item is activity; a person's word to the reporter rings
describe('what a reporter is told', () => {
  const tell = (kind: string, eventId: string) =>
    consumerOf('feedback.reporterTold', 'notify-feedback')?.handle(
      {
        projectId: 'p1',
        feedbackId: 'f2',
        kind,
        recipients: ['u-rep'],
        title: 'FB-5 · x',
        body: '',
      },
      { eventId } as never,
    );

  it("keeps a step on the item's history as activity, and a person's message on the bell", async () => {
    state.notices.length = 0;
    await tell('step', 'e-step');
    await tell('verified', 'e-verified');
    await tell('message', 'e-message');
    await tell('declined', 'e-declined');
    expect(state.notices.map((n) => n.type)).toEqual([
      'feedback_step',
      'feedback_step',
      'feedback_message',
      'feedback_message',
    ]);
    expect(new Set(state.notices.map((n) => n.feedbackId))).toEqual(new Set(['f2']));
  });
});
