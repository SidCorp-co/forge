import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeAssistantPreferences = vi.fn();
vi.mock('../../auth/preference-changes.js', () => ({
  writeAssistantPreferences: (...a: unknown[]) => writeAssistantPreferences(...(a as [])),
}));
const handleForProject = vi.fn(async () => 'handle-1');
vi.mock('../../conversations/participants.js', () => ({
  handleForProject: (...a: unknown[]) => handleForProject(...(a as [])),
}));

import { forgePreferencesTool } from './forge-preferences-tool.js';

type Ctx = Parameters<typeof forgePreferencesTool>[0];
const ctx = (turn: Ctx['turn']): Ctx =>
  ({ principal: { userId: 'agent-1' }, boundProjectId: 'p1', projectSlug: 'alpha', turn }) as never;
const call = (c: Ctx, raw: Record<string, unknown>) =>
  (forgePreferencesTool(c).handler as (r: Record<string, unknown>) => Promise<unknown>)(raw);

beforeEach(() => {
  writeAssistantPreferences.mockReset();
  writeAssistantPreferences.mockResolvedValue({
    answerStyle: 'concise',
    assistantInstructions: null,
  });
  handleForProject.mockClear();
});

describe('forge_preferences writes for the linked speaker and nobody else', () => {
  it('sets the speaker’s style as the assistant, in the room it was asked in', async () => {
    const out = await call(ctx({ conversationId: 'c1', speakerUserId: 'alice' }), {
      answerStyle: 'concise',
    });
    expect(writeAssistantPreferences).toHaveBeenCalledWith({
      userId: 'alice',
      patch: { answerStyle: 'concise' },
      actor: { kind: 'assistant', userId: 'handle-1' },
      conversationId: 'c1',
    });
    expect(out).toEqual({ answerStyle: 'concise', assistantInstructions: null });
  });

  // cm:guard the principal is `agent-1` and the speaker is null, and the assertion is that NOTHING was written: a tool that fell back to the principal here would restyle the org agent's own account on a stranger's say-so (ISS-1034 criterion 22).
  it('refuses a turn whose newest message is from nobody Forge knows, and writes nothing', async () => {
    await expect(
      call(ctx({ conversationId: 'c1', speakerUserId: null }), { answerStyle: 'concise' }),
    ).rejects.toThrow(/nobody Forge knows/);
    expect(writeAssistantPreferences).not.toHaveBeenCalled();
  });

  it('refuses a turn that carries no speaker facts at all', async () => {
    await expect(call(ctx(undefined), { answerStyle: 'concise' })).rejects.toThrow(
      /nobody Forge knows/,
    );
    expect(writeAssistantPreferences).not.toHaveBeenCalled();
  });

  // cm:guard asserted on the advertised schema AND on a live call: a `userId` the schema does not declare is a whole-call refusal, so the model has no argument through which to name whose preferences change (ISS-1034 criterion 23).
  it('declares no argument naming a user, and refuses one', async () => {
    const schema = forgePreferencesTool(ctx(undefined)).inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['answerStyle', 'assistantInstructions']);
    await expect(
      call(ctx({ conversationId: 'c1', speakerUserId: 'alice' }), {
        answerStyle: 'concise',
        userId: 'bob',
      }),
    ).rejects.toThrow();
    expect(writeAssistantPreferences).not.toHaveBeenCalled();
  });

  it('refuses a call that sets nothing', async () => {
    await expect(call(ctx({ conversationId: 'c1', speakerUserId: 'alice' }), {})).rejects.toThrow(
      /at least one/,
    );
  });

  it('clears standing instructions with null', async () => {
    await call(ctx({ conversationId: 'c1', speakerUserId: 'alice' }), {
      assistantInstructions: null,
    });
    expect(writeAssistantPreferences.mock.calls[0]?.[0]).toMatchObject({
      patch: { assistantInstructions: null },
    });
  });
});
