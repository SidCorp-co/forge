// While a chat turn runs, only the person it answers is shown its draft and its tool calls (REQ-32
// criterion 6). Lane A8b found the live stream showing every reader of the room each tool call's
// input — forge_show's block, a refused label's text included — and the draft before the reply
// screen judged it. The split is taken at the fan-out, so these read what each socket is handed.

import { describe, expect, it, vi } from 'vitest';

const ASKER = 'u-asker';
const OTHER = 'u-other';

type Frame = {
  view: string;
  rev: number;
  entry: { content?: string; blocks?: unknown[] };
  tools?: { name: string; done: boolean; durationMs?: number }[];
  verdict?: string;
  replaced?: boolean;
};
const sent: { userIds: readonly string[]; data: Frame }[] = [];

vi.mock('../outbox/index.js', () => ({ emitEvent: vi.fn() }));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../conversations/index.js', () => ({
  listParticipants: async () => [
    { kind: 'person', userId: ASKER },
    { kind: 'person', userId: OTHER },
    { kind: 'handle', userId: 'h-1' },
  ],
  assertConversationReadable: async () => undefined,
  findConversation: async () => null,
}));
vi.mock('../lib/ephemeral.js', () => ({
  publishEphemeral: (target: { userIds?: readonly string[] }, frame: { data: Frame }) => {
    sent.push({ userIds: target.userIds ?? [], data: frame.data });
  },
}));

const { ConversationProgress } = await import('./conversation-progress.js');

const DRAFT = 'REQ-4 is 90% done.';
const LABEL_INPUT = { kind: 'status-list', frame: { label: 'ninety per cent done' } };

/** Everything a socket was handed, as one string, so no field can hide a word. */
const seenBy = (userId: string) =>
  JSON.stringify(sent.filter((f) => f.userIds.includes(userId)).map((f) => f.data));
const framesTo = (userId: string) =>
  sent.filter((f) => f.userIds.includes(userId)).map((f) => f.data);

async function runTurn(settle: { text: string; screenReplaced: boolean; heldPart?: true } | null) {
  sent.length = 0;
  const progress = new ConversationProgress('c-1', 'e-1');
  progress.askedBy(ASKER);
  progress.begin();
  progress.onTurnEvent({
    type: 'tool_call',
    id: 't-1',
    name: 'forge_show',
    arguments: JSON.stringify(LABEL_INPUT),
  } as never);
  progress.onTurnEvent({
    type: 'tool_result',
    id: 't-1',
    result: 'refused: a typed figure in the label',
    isError: true,
    durationMs: 420,
  } as never);
  progress.onTurnEvent({ type: 'chunk', text: DRAFT } as never);
  progress.onTurnEvent({ type: 'tool_call', id: 't-2', name: 'forge', arguments: '{}' } as never);
  if (settle) progress.onSettled(settle);
  await progress.close();
}

describe('a second member of the room, during a turn', () => {
  it('is never handed the draft or any tool input or output', async () => {
    await runTurn({ text: 'REQ-4 has three of four criteria agreed.', screenReplaced: true });
    const other = seenBy(OTHER);
    expect(other).not.toContain('90%');
    expect(other).not.toContain('ninety per cent');
    expect(other).not.toContain('typed figure');
    expect(other).not.toContain('status-list');
    expect(framesTo(OTHER).every((f) => f.view === 'room')).toBe(true);
  });

  it('is handed that the turn works and its tools by name and time', async () => {
    await runTurn(null);
    const tools = framesTo(OTHER).at(-1)?.tools;
    expect(tools).toEqual([
      { id: 't-1', name: 'forge_show', done: true, durationMs: 420, isError: true },
      { id: 't-2', name: 'forge', done: false },
    ]);
  });

  it('is not handed a frame for a text flush, which changes nothing it is shown', async () => {
    sent.length = 0;
    const progress = new ConversationProgress('c-1', 'e-4');
    progress.askedBy(ASKER);
    progress.onTurnEvent({ type: 'tool_call', id: 't-1', name: 'forge', arguments: '{}' } as never);
    for (const word of ['REQ-4 ', 'is ', '90% done.']) {
      await new Promise((r) => setTimeout(r, 130));
      progress.onTurnEvent({ type: 'chunk', text: word } as never);
    }
    await progress.close();
    expect(framesTo(ASKER).filter((f) => f.verdict === undefined)).toHaveLength(4);
    expect(framesTo(OTHER).filter((f) => f.verdict === undefined)).toHaveLength(1);
  });
});

describe('the person the turn answers', () => {
  it('is handed the draft and the tool calls in full, the draft unmarked until the verdict', async () => {
    await runTurn({ text: 'REQ-4 has three of four criteria agreed.', screenReplaced: true });
    const mine = framesTo(ASKER);
    expect(mine.every((f) => f.view === 'asker')).toBe(true);
    const drafting = mine.find((f) => f.entry.content === DRAFT);
    expect(drafting?.verdict).toBeUndefined();
    expect(seenBy(ASKER)).toContain('ninety per cent');
    expect(seenBy(ASKER)).toContain('typed figure');
  });

  it('has the draft replaced by the checked reply at the verdict, with the withdrawn draft named', async () => {
    await runTurn({ text: 'REQ-4 has three of four criteria agreed.', screenReplaced: true });
    const last = framesTo(ASKER).at(-1);
    expect(last?.verdict).toBe('checked');
    expect(last?.entry.content).toBe('REQ-4 has three of four criteria agreed.');
    expect(last?.replaced).toBe(true);
    expect(framesTo(OTHER).at(-1)?.verdict).toBe('checked');
  });

  it('is told a draft was replaced, but never handed the withdrawn words again after the verdict (BC-6)', async () => {
    await runTurn({ text: 'REQ-4 has three of four criteria agreed.', screenReplaced: true });
    const verdictFrames = framesTo(ASKER).filter((f) => f.verdict !== undefined);
    expect(verdictFrames.length).toBeGreaterThan(0);
    expect(JSON.stringify(verdictFrames)).not.toContain('90%');
    expect(JSON.stringify(verdictFrames)).not.toContain(DRAFT);
  });
});

describe('a reply the screen held', () => {
  it('takes the draft back from the asker and never reaches the second member', async () => {
    await runTurn(null);
    const last = framesTo(ASKER).at(-1);
    expect(last?.verdict).toBe('withheld');
    expect(JSON.stringify(last?.entry)).not.toContain('90%');
    expect(seenBy(OTHER)).not.toContain('90%');
    expect(framesTo(OTHER).at(-1)?.verdict).toBe('withheld');
  });

  it('settles as `partial` where the part the check passed went out, never as checked or withheld (REQ-41 BC-3)', async () => {
    const shown =
      'REQ-4 has three of four criteria agreed.\n\nThe reply check left out a figure that nothing this answer read backs. What is shown above was checked.';
    await runTurn({ text: shown, screenReplaced: true, heldPart: true });
    const last = framesTo(ASKER).at(-1);
    expect(last?.verdict).toBe('partial');
    expect(last?.entry.content).toBe(shown);
    expect(JSON.stringify(last?.entry)).not.toContain('90%');
    expect(framesTo(OTHER).at(-1)?.verdict).toBe('partial');
  });
});

describe('a turn whose asker is not named', () => {
  it('hands every reader the room view', async () => {
    sent.length = 0;
    const progress = new ConversationProgress('c-1', 'e-2');
    progress.onTurnEvent({ type: 'chunk', text: DRAFT } as never);
    progress.onTurnEvent({
      type: 'tool_call',
      id: 't-1',
      name: 'forge',
      arguments: '{"argv":["x"]}',
    } as never);
    await progress.close();
    expect(seenBy(ASKER)).not.toContain('90%');
    expect(seenBy(OTHER)).not.toContain('argv');
    expect(sent.every((f) => f.data.view === 'room')).toBe(true);
  });

  it('a continuation keeps the asker its first part was given', async () => {
    sent.length = 0;
    const progress = new ConversationProgress('c-1', 'e-3');
    progress.askedBy(ASKER);
    const rest = progress.next();
    rest.onTurnEvent({ type: 'chunk', text: DRAFT } as never);
    await rest.close();
    await progress.close();
    expect(seenBy(ASKER)).toContain('90%');
    expect(seenBy(OTHER)).not.toContain('90%');
  });
});
