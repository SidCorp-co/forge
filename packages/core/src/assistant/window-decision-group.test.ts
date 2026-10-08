// A group room's window, read for whom it speaks to. Production Rocket.Chat rooms, September 2026
// (chat mining, 2026-10-07): the handle answered messages that tagged only a colleague, said it
// would stop when told to and spoke again, and people asked for it to be removed. Every message
// below is one of those, with the people renamed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Said {
  author: string;
  content: string;
}

const state: {
  said: Said[];
  presence: Record<string, unknown> | null;
  quieted: unknown[];
  turns: { message: string; speakerKey: string }[];
} = { said: [], presence: null, quieted: [], turns: [] };

vi.mock('../orgs/index.js', async () => {
  const { z } = await import('zod');
  return {
    boundedPresence: () => z.number(),
    presenceInvalid: (issues: string[]) => new Error(issues.join('; ')),
    readSelvesFor: async () => new Map(),
  };
});
vi.mock('../conversations/index.js', async () => {
  const presence = await vi.importActual<typeof import('../conversations/presence.js')>(
    '../conversations/presence.js',
  );
  return {
    applyRoomPresence: presence.applyRoomPresence,
    foldPresence: presence.foldPresence,
    groupHearing: presence.groupHearing,
    replyTargetsOf: presence.replyTargetsOf,
    windowAddressesAHandle: presence.windowAddressesAHandle,
    deliveredDecisionUnderKey: async () => null,
    getConversation: async () => ({
      id: 'c-1',
      adapter: 'rocketchat',
      externalId: 'room-1',
      shape: 'group',
      mode: null,
      title: null,
      presence: state.presence,
    }),
    readMessagesInRange: async () =>
      state.said.map((s, i) => ({
        id: `m-${i + 1}`,
        seq: i + 1,
        externalId: `x-${i + 1}`,
        role: 'user',
        authorUserId: `u-${s.author}`,
        authorLabel: s.author,
        authorKey: s.author,
        replyToExternalId: null,
        content: s.content,
        blocks: null,
        images: [],
        deliveryProof: null,
        silenceReason: null,
        createdAt: new Date(),
      })),
    roomHandles: async () => [{ userId: 'h-1', handle: 'helper' }],
    assistantSentExternalIds: async () => new Set<string>(),
    conversationTransport: () => null,
    decideProactivity: async () => ({ speak: true }),
    setRoomQuiet: async (_id: string, quiet: unknown) => {
      state.quieted.push(quiet);
    },
    messageAuthorTokenId: async () => null,
    linkedSpeakerOf: () => ({ userId: null }),
    handleForProject: async () => 'h-1',
    effectiveConversationMode: () => 'assistant',
    explicitAnchor: () => null,
    replyLanguageOf: () => 'vi',
    languageOfTag: () => 'vi',
    personCount: async () => 3,
    acknowledgeRequest: () => null,
    reserveDelivery: async () => undefined,
    withTerminalStatus: async (routed: unknown) => routed,
  };
});
vi.mock('../onboarding/index.js', () => ({
  onboardingRoomOf: async () => null,
  firstRequirementsOnboardingOf: () => null,
  firstRequirementsStarterOf: async () => null,
}));
vi.mock('../permissions/index.js', () => ({
  resolveTurnAuthority: async ({ userId }: { userId: string }) => ({
    ok: true,
    authority: { userId, origin: 'message' },
  }),
}));
vi.mock('../project-config/index.js', () => ({
  readContentLanguage: async () => ({ contentLanguage: 'vi' }),
}));
vi.mock('./authority-refusal.js', () => ({
  refuseAuthority: async () => ({ decision: 'authority-refused', detail: {} }),
}));
vi.mock('./turn-origin.js', () => ({
  handoffPersonSpoke: () => true,
  handoffVenueRefusal: () => null,
}));
vi.mock('./turn-runner.js', () => ({
  runConversationTurn: async (args: { message: string; speakerKey: string }) => {
    state.turns.push({ message: args.message, speakerKey: args.speakerKey });
    return { kind: 'delivered', messageId: 'reply-1' };
  },
}));

const { decide } = await import('./window-decision.js');

async function route(...said: Said[]) {
  state.said = said;
  return decide(
    {
      window: {
        id: 'w-1',
        conversationId: 'c-1',
        projectId: 'p-1',
        adapter: 'rocketchat',
        origin: 'message',
        firstSeq: 1,
        lastSeq: said.length,
        deliveryReservedAt: null,
        extendedAt: new Date(),
      },
      inputs: () => ({ handleName: 'helper' }),
    } as never,
    'key-1',
    {} as never,
    { current: {} } as never,
    {} as never,
  );
}

beforeEach(() => {
  state.presence = null;
  state.quieted = [];
  state.turns = [];
});

describe('a group room message that tags only a person is theirs', () => {
  it('stays quiet over a window that tags only a colleague', async () => {
    const routed = await route({ author: 'tram', content: '@an để e xem nha' }); // i18n-allow: production message, renamed
    expect(routed).toMatchObject({
      decision: 'nothing-to-say',
      detail: { reason: 'addressed-to-person' },
    });
    expect(state.turns).toEqual([]);
  });

  it('answers the person who asked the handle, without the message meant for a colleague', async () => {
    await route(
      { author: 'binh', content: '@helper ISS-84 đang Open mà sao không chạy?' }, // i18n-allow: production message, renamed
      { author: 'tram', content: '@an ơi xem giúp em cái này' }, // i18n-allow: production message, renamed
    );
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.speakerKey).toBe('binh');
    expect(state.turns[0]?.message).not.toContain('@an');
  });
});

describe('a stop request quiets the room until the handle is named again', () => {
  it('records the quiet on the room and takes no turn', async () => {
    const routed = await route({ author: 'cuong', content: 'cút đi @helper' }); // i18n-allow: production message, renamed
    expect(routed).toMatchObject({
      decision: 'nothing-to-say',
      detail: { reason: 'asked-to-stop', by: 'cuong' },
    });
    expect(state.quieted).toEqual([expect.objectContaining({ by: 'cuong' })]);
    expect(state.turns).toEqual([]);
  });

  it('stays quiet in a quiet room over a message that does not name the handle', async () => {
    state.presence = { quiet: { since: '2026-09-15T02:26:04.000Z', by: 'cuong' } };
    const routed = await route({ author: 'dung', content: 'nó bảo ko phản hồi nữa rồi kìa :D' }); // i18n-allow: production message, renamed
    expect(routed).toMatchObject({
      decision: 'nothing-to-say',
      detail: { reason: 'quiet-until-mentioned', since: '2026-09-15T02:26:04.000Z', by: 'cuong' },
    });
    expect(state.turns).toEqual([]);
  });

  it('answers again once the handle is named, and lifts the quiet', async () => {
    state.presence = { quiet: { since: '2026-09-15T02:26:04.000Z', by: 'cuong' } };
    await route({ author: 'dung', content: '@helper kiểm tra giúp ISS-12' }); // i18n-allow: production message, renamed
    expect(state.turns).toHaveLength(1);
    expect(state.quieted).toEqual([null]);
  });
});
