/**
 * The door a Forge UI reply goes out of, judged by what it lets through.
 *
 * ISS-1005. The door is READ off `webConversationTurn` rather than named here,
 * so this file is about what production selects: point that function back at
 * `chat-sync` and every case below reds, which is the only thing that makes the
 * three passes mean anything (criterion 7).
 */

import { describe, expect, it, vi } from 'vitest';

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
import { webConversationPersona } from './door-persona.js';

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
const screenAtWebDoor = (text: string, facts = NO_FACTS) =>
  screenMessage({ ...doorCell(webDoor() as never), segments: [text], facts });

/** A progress snapshot, as `screenedTurnReply` hands the turn's own to the screen. */
const PROGRESS = {
  ...NO_FACTS,
  progress: { shipped: 7, closedUnshipped: 1, inFlight: 2, remaining: 3, total: 13 },
};

describe('the Forge UI reply door', () => {
  it('is read at a cell for a reader who holds a role on the project', () => {
    expect(doorPolicy(webDoor() as never).cell).toBe('role:chat');
  });

  it('answers somebody who is waiting, so it ends in a fallback rather than a refusal', () => {
    const policy = doorPolicy(webDoor() as never);
    expect(policy.ending).toBe('fallback');
    expect(policy.ending === 'fallback' ? policy.repairs : null).toBe(1);
  });

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

  it('still refuses a promise no later turn will keep', () => {
    const v = screenAtWebDoor('I will look into that and get back to you shortly.');
    expect(v.ok).toBe(false);
    expect(v.ok ? [] : v.refusals.map((r) => r.rule)).toContain('no-empty-promise');
  });

  it('still refuses a figure the turn’s own snapshot contradicts', () => {
    const v = screenAtWebDoor('9 remaining, and 4 in progress.', PROGRESS);
    expect(v.ok).toBe(false);
    expect(v.ok ? [] : v.refusals.map((r) => r.rule)).toContain('progress-figures-match');
  });

  it('lets the same figure through when it is the one the turn was shown', () => {
    const v = screenAtWebDoor('3 remaining, and 2 in progress.', PROGRESS);
    expect(v.ok).toBe(true);
  });

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

describe('the persona the Forge UI turn carries', () => {
  it('names the runner surface as a route a person can actually follow', () => {
    const persona = webConversationPersona('Forge', 'forge-dev', 'Alice');
    expect(persona).toContain('/projects/forge-dev/agents');
    // `forge guide <slug>` in the inlined method is a CLI placeholder the model fills; the route one is the defect.
    expect(persona).not.toContain('/projects/<slug>');
  });
});
