/**
 * The door a Forge UI reply goes out of, judged by what it lets through.
 *
 * ISS-1005. The door is READ off `webConversationTurn` rather than named here,
 * so this file is about what production selects: point that function back at
 * `chat-sync` and every case below reds, which is the only thing that makes the
 * three passes mean anything (criterion 7).
 */

import { describe, expect, it, vi } from 'vitest';

// cm:guard the mocks here stand in for a database connection and a tool catalogue, never for anything under test: `conversation-send.ts` reaches `db/client.js` and `external-chat.js` through its imports, and both parse the environment at module load. The door table, `doorCell`, `webConversationTurn` and `screenMessage` are all REAL in this file — mocking any of those would make it a claim about nothing, which is the whole risk this file exists to avoid (ISS-1005).
vi.mock('../conversations/collect-inbound.js', () => ({ collectInboundMessage: () => undefined }));
vi.mock('../conversations/route-window.js', () => ({ routeWindow: () => undefined }));
vi.mock('../conversations/windows.js', () => ({
  claimDueWindows: () => [],
  claimOf: () => null,
  releaseWindow: () => undefined,
}));
vi.mock('../conversations/handles.js', () => ({ resolveProjectHandle: () => undefined }));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('./tools/registry.js', () => ({ buildProjectToolset: () => ({ tools: [] }) }));
vi.mock('./tools/principal.js', () => ({ buildChatToolContext: (a: unknown) => a }));

import { doorCell, doorPolicy } from '../messaging/doors.js';
import { NO_FACTS } from '../messaging/facts.js';
import { screenMessage } from '../messaging/screen.js';
import { webConversationTurn } from './conversation-send.js';

/** The door the code picks, not a door this file picked. */
const webDoor = (): string =>
  webConversationTurn({
    project: { id: 'p1', slug: 'forge-dev', name: 'Forge' },
    handleName: 'Babo',
    askedBy: 'Alice',
  }).door;

/**
 * Judged with no gathered facts, and that is honest for these three.
 */
// cm:guard `no-developer-detail` — the rule all three of these cases turn on — declares `needs: []`, so it reads nothing from the database and `NO_FACTS` withholds nothing it would have used. The one case that DOES need gathered facts, a status the row contradicts, is deliberately not here: it is judged against real Postgres in `messaging/web-door-facts.integration.test.ts`, because a unit test could only assert a pass that proved no facts were gathered (ISS-1005, review F2).
const screenAtWebDoor = (text: string) =>
  screenMessage({ ...doorCell(webDoor() as never), segments: [text], facts: NO_FACTS });

describe('the Forge UI reply door', () => {
  it('is read at a cell for a reader who holds a role on the project', () => {
    expect(doorPolicy(webDoor() as never).cell).toBe('role:report');
  });

  it('answers somebody who is waiting, so it ends in a fallback rather than a refusal', () => {
    const policy = doorPolicy(webDoor() as never);
    expect(policy.ending).toBe('fallback');
    expect(policy.ending === 'fallback' ? policy.repairs : null).toBe(1);
  });

  // cm:guard the three shapes `webConversationPersona` INSTRUCTS the model to produce — it says to lead with what was found and to answer a status question with the figures — and which `public:report` refuses. A door that refuses its own persona's output burns the single repair and serves `unverifiedFallbackReply`, which tells the person the figures could not be reconciled when nothing of the sort happened (ISS-1005).
  it('lets a raw pipeline status word through, because the reader can open the tracker', () => {
    const v = screenAtWebDoor('Two issues are still open and one is on_hold; nothing is blocked.');
    expect(v.ok).toBe(true);
  });

  it('lets a source file and line through', () => {
    const v = screenAtWebDoor('That check lives in scripts/verify.mjs:12 and runs on every push.');
    expect(v.ok).toBe(true);
  });

  it('lets a fenced code block through', () => {
    const v = screenAtWebDoor('Run it like this:\n```\npnpm verify\n```');
    expect(v.ok).toBe(true);
  });

  // cm:guard the control: the SAME three texts at the door this reply used to go out of, proving the cases above are about the move and not about three strings that pass everywhere. `chat-sync` is unchanged by ISS-1005 and still serves Rocket.Chat, so this also reds if that row is disturbed.
  it('refuses all three at chat-sync, which is what the browser used to be screened at', () => {
    const cell = doorCell('chat-sync');
    for (const text of [
      'Two issues are still open and one is on_hold; nothing is blocked.',
      'That check lives in scripts/verify.mjs:12 and runs on every push.',
      'Run it like this:\n```\npnpm verify\n```',
    ]) {
      const v = screenMessage({ ...cell, segments: [text], facts: NO_FACTS });
      expect(v.ok, text).toBe(false);
      expect(v.ok ? [] : v.refusals.map((r) => r.rule)).toContain('no-developer-detail');
    }
  });
});
