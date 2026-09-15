/**
 * ISS-1034 — who a turn speaks AS and who it speaks TO are two different reads.
 *
 * The self comes off the handle the turn runs under; the speaker section comes
 * off the person whose message it answers. Neither is read off the principal.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const readSelvesFor = vi.fn(async (_ids: string[]) => new Map<string, unknown>());
vi.mock('../orgs/agent-selves.js', () => ({
  readSelvesFor: (ids: string[]) => readSelvesFor(ids),
}));

const readAssistantPreferences = vi.fn(async (_userId: string) => null as unknown);
vi.mock('../auth/preference-changes.js', () => ({
  readAssistantPreferences: (userId: string) => readAssistantPreferences(userId),
}));

const { loadTurnSelf } = await import('./turn-self.js');

const SELF = { soul: 'I am Babo.', instructions: 'Answer plainly.', presence: {} };

describe('loadTurnSelf', () => {
  it('reads the self off the handle and the preferences off the speaker, and renders the style line', async () => {
    readSelvesFor.mockResolvedValueOnce(new Map([['handle-1', SELF]]));
    readAssistantPreferences.mockResolvedValueOnce({
      answerStyle: 'concise',
      assistantInstructions: 'Cite the row.',
    });

    const out = await loadTurnSelf({
      handleUserId: 'handle-1',
      speakerUserId: 'speaker-1',
      speakerLabel: 'thanh',
    });

    expect(readSelvesFor).toHaveBeenCalledWith(['handle-1']);
    expect(readAssistantPreferences).toHaveBeenCalledWith('speaker-1');
    expect(out.self).toEqual(SELF);
    expect(out.speakerContext).toContain('Reply style for the person you are answering: concise');
    expect(out.speakerContext).toContain('Cite the row.');
  });

  it('says the speaker is unlinked, and reads nothing, when no Forge user is behind the message', async () => {
    readSelvesFor.mockClear();
    readAssistantPreferences.mockClear();

    const out = await loadTurnSelf({
      handleUserId: null,
      speakerUserId: null,
      speakerLabel: 'guest.42',
    });

    expect(readSelvesFor).not.toHaveBeenCalled();
    expect(readAssistantPreferences).not.toHaveBeenCalled();
    expect(out.self).toBeNull();
    expect(out.speakerContext).toContain('guest.42');
    expect(out.speakerContext).toContain('not linked to a Forge user');
  });

  it('carries no preference line for a linked speaker who has set nothing', async () => {
    readSelvesFor.mockResolvedValueOnce(new Map());
    readAssistantPreferences.mockResolvedValueOnce({
      answerStyle: 'default',
      assistantInstructions: null,
    });

    const out = await loadTurnSelf({
      handleUserId: 'handle-1',
      speakerUserId: 'speaker-1',
      speakerLabel: 'thanh',
    });

    expect(out.self).toBeNull();
    expect(out.speakerContext).toBeNull();
  });
});
