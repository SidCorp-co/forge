import { capabilityCardSchema } from '@forge/contracts/capability-cards';
import { SUPPORT_ACTIONS } from '@forge/contracts/support';
import { OPERATIONS_ACTIONS } from '@forge/contracts/support-operations';
import { describe, expect, it } from 'vitest';
import { SUPPORT_ACT_CARDS, type SupportAction } from './act-cards.js';
import { forgeSupportTool, SUPPORT_ACT_REQUESTS } from './tool.js';
import { supportActEntries, UNCARDED_ENTRIES } from './tool-description.js';

const ACTIONS: SupportAction[] = [...new Set([...SUPPORT_ACTIONS, ...OPERATIONS_ACTIONS])];
const tool = forgeSupportTool({
  principal: { userId: 'u', tokenId: 't', projectIds: ['p'], boundProjectId: null },
} as never);

describe("forge_support's description is rendered from the room acts' cards (ISS-1251)", () => {
  it("gives each carded act its card's purpose, and no entry of its own beside the card", () => {
    for (const act of ACTIONS) {
      const body = SUPPORT_ACT_CARDS[act];
      const entry = tool.actionEntries?.[act] ?? '';
      if (body) {
        expect(UNCARDED_ENTRIES[act], `${act} has a card`).toBeUndefined();
        expect(entry).toContain(`}: ${capabilityCardSchema.parse(body).purpose}`);
      } else {
        expect(entry, `${act} has no card`).toContain(`}: ${UNCARDED_ENTRIES[act]}`);
      }
    }
  });

  it('refuses by name an act holding a card and an entry, and one holding neither', () => {
    expect(() => supportActEntries(['decide'], ['tools {}'])).toThrow(
      'forge_support lists no shape for decide',
    );
    // every act with a card has its own entry deleted, so the act the cards builder cards next
    // goes red here until its hand-written entry is gone
    const both = Object.keys(UNCARDED_ENTRIES).filter((a) => a in SUPPORT_ACT_CARDS);
    expect(both).toEqual([]);
  });

  it('reads each entry alone, so a word naming another act is no entry of it', () => {
    // in_flight's card says "a thread and its asker: items", which the whole text would read as asker's
    expect(tool.actionEntries?.in_flight).toMatch(/its asker: /);
    expect(tool.actionEntries?.asker?.startsWith('asker { thread, message }: ')).toBe(true);
  });

  it('is a map of the acts, under half the hand-written 27 KB it replaced', () => {
    expect(tool.description.length).toBeLessThan(14_000);
  });
});

describe('an act that names a message takes the thread a room-ambiguous refusal asks for (ISS-1361)', () => {
  it('lets every act whose request carries `message` carry `thread` too', () => {
    // SUPPORT_ROOM_AMBIGUOUS tells a channel agent to "name the thread you were handed": an act
    // naming a message and refusing `thread` sent the epod agent from that advice to a BAD_REQUEST
    const missing = Object.entries(SUPPORT_ACT_REQUESTS).flatMap(([act, schema]) => {
      const shape = (schema as { shape?: Record<string, unknown> }).shape ?? {};
      return 'message' in shape && !('thread' in shape) ? [act] : [];
    });
    expect(missing).toEqual([]);
  });
});
