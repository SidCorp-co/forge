// Who may edit a bot message in place, read from the message's own record (ISS-1417): agenfold's
// 0.310.0 release-check report rewrote the room agent's answer, which no report may take.
// @direct-test-of packages/core/src/support/post-edit-door.ts

import { describe, expect, it } from 'vitest';
import { type Editor, editRefusal } from './post-edit-door.js';
import type { ActionRow } from './store.js';

const PROJECT = 'p-agenfold';
const at = (n: number) => new Date(Date.UTC(2026, 10, 22, 9, n));

const row = (over: Partial<ActionRow>): ActionRow =>
  ({
    projectId: PROJECT,
    kind: 'reply',
    actorKind: 'session',
    tool: null,
    input: {},
    createdAt: at(38),
    ...over,
  }) as ActionRow;

const agentReply = row({});
const post = (input: Record<string, unknown>, n = 40) =>
  row({
    kind: 'routed',
    tool: 'master_post',
    input: { by: 'u-master', ...input },
    createdAt: at(n),
  });

const report: Editor = { kind: 'report', projectId: PROJECT, report: 'release 0.310.0' };
const oneVoice: Editor = { kind: 'one-voice' };
const own: Editor = { kind: 'own-post', projectId: PROJECT, by: 'u-master' };

const code = (refused: ReturnType<typeof editRefusal>) =>
  refused && !refused.ok ? refused.refusals[0]?.code : null;

describe('editRefusal', () => {
  it("refuses a report's edit of the room agent's reply, naming whose it is", () => {
    const refused = editRefusal([agentReply], 'JaLT7Xvfaf7BYQKMf', report);
    expect(code(refused)).toBe('SUPPORT_EDIT_NOT_ITS_OWN');
    expect(refused && !refused.ok ? refused.refusals[0]?.detail : '').toContain(
      "the room agent's reply",
    );
  });

  it("refuses a report's edit of a master's answer and of another report", () => {
    expect(code(editRefusal([post({})], 'm1', report))).toBe('SUPPORT_EDIT_NOT_ITS_OWN');
    expect(code(editRefusal([post({ report: 'release 0.308.0' })], 'm1', report))).toBe(
      'SUPPORT_EDIT_NOT_ITS_OWN',
    );
    // the same report made for another project is not this one's
    expect(
      code(editRefusal([post({ report: 'release 0.310.0', for: 'p-other' })], 'm1', report)),
    ).toBe('SUPPORT_EDIT_NOT_ITS_OWN');
  });

  it('lets a report update its own earlier post of the same report', () => {
    expect(editRefusal([post({ report: 'release 0.310.0' })], 'm1', report)).toBeNull();
  });

  it("lets one voice replace the agent's reply or a master's answer, never a report", () => {
    expect(editRefusal([agentReply], 'm1', oneVoice)).toBeNull();
    expect(editRefusal([post({})], 'm1', oneVoice)).toBeNull();
    expect(code(editRefusal([post({ report: 'release 0.310.0' })], 'm1', oneVoice))).toBe(
      'SUPPORT_EDIT_NOT_ITS_OWN',
    );
  });

  it('lets a master edit only the post that stands as its own, not one another voice replaced', () => {
    expect(editRefusal([post({})], 'm1', own)).toBeNull();
    // a master's post replaced the agent's reply: the message is that master's now
    expect(editRefusal([agentReply, post({})], 'm1', own)).toBeNull();
    // another master's post has since replaced it
    expect(code(editRefusal([post({}), post({ by: 'u-other' }, 45)], 'm1', own))).toBe(
      'SUPPORT_EDIT_NOT_ITS_OWN',
    );
    expect(code(editRefusal([agentReply], 'm1', own))).toBe('SUPPORT_EDIT_NOT_ITS_OWN');
  });

  it('refuses any edit of a message core holds no record of', () => {
    for (const editor of [report, oneVoice, own]) {
      expect(code(editRefusal([], 'unknown', editor))).toBe('SUPPORT_EDIT_NOT_ITS_OWN');
    }
  });
});
