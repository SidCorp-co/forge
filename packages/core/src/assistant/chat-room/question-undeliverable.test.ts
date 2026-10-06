import { describe, expect, it } from 'vitest';
import { NO_ROOM_REASON } from './question-destination.js';
import { undeliverableNotice } from './question-ledger.js';

// F12: the bell row says why the question was not posted and what fixes it
describe('the notice a question that cannot be posted to chat raises', () => {
  it('names why in the line the bell shows, and the fix in its body', () => {
    const n = undeliverableNotice('HOP', NO_ROOM_REASON);
    expect(n.title).toContain(NO_ROOM_REASON);
    expect(n.groupTitle).toContain(NO_ROOM_REASON);
    expect(n.body).toContain('Answer it');
    expect(n.body).toContain('Integrations');
  });

  it('still says where to answer it when the reason has no setting to change', () => {
    const n = undeliverableNotice('HOP', 'this bot can no longer post in room r1');
    expect(n.title).toContain('this bot can no longer post in room r1');
    expect(n.body).toContain('Answer it');
    expect(n.body).not.toContain('Integrations');
  });
});
