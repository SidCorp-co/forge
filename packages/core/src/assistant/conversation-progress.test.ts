/**
 * ISS-1229 r36, judge-97: a reply the reply check withdrew was said in the room only by a socket frame,
 * so after a reload nothing said a reply had ever been withdrawn. The watcher now hands the withdrawn
 * draft to the row the reply is stored as.
 */
import { describe, expect, it } from 'vitest';
import { startConversationProgress } from './conversation-progress.js';

function watched() {
  const frames: unknown[] = [];
  const progress = startConversationProgress({
    conversationId: 'c1',
    entryId: 'e1',
    publish: async (_id, envelope) => {
      frames.push(envelope.data);
      return 1;
    },
  });
  return { progress, frames };
}

describe('the draft a turn withdrew', () => {
  it('is kept for the stored reply where the screen replaced what streamed', async () => {
    const { progress, frames } = watched();
    progress.onTurnEvent({ type: 'chunk', text: 'ISS-4242 shipped in v9.2.' });
    progress.onSettled({ text: 'I could not verify that.', screenReplaced: true });
    await progress.close();
    expect(progress.withdrawnDraft()).toBe('ISS-4242 shipped in v9.2.');
    expect(frames.at(-1)).toMatchObject({ replaced: { draft: 'ISS-4242 shipped in v9.2.' } });
  });

  it('is none where the reply went out as it streamed, or was only corrected', async () => {
    const asStreamed = watched();
    asStreamed.progress.onTurnEvent({ type: 'chunk', text: 'Two issues are open.' });
    asStreamed.progress.onSettled({ text: 'Two issues are open.', screenReplaced: false });
    expect(asStreamed.progress.withdrawnDraft()).toBeNull();

    const corrected = watched();
    corrected.progress.onTurnEvent({ type: 'chunk', text: 'Two issues are open' });
    corrected.progress.onSettled({
      text: 'Two issues are open, both bugs.',
      screenReplaced: false,
    });
    expect(corrected.progress.withdrawnDraft()).toBeNull();
    await Promise.all([asStreamed.progress.close(), corrected.progress.close()]);
  });
});

/**
 * ISS-1229 r43, judge-120: a reply withheld for holding a token-looking URL was stored whole as the
 * withdrawn draft, and sent to every reader as the frame that withdrew it. A secret the check caught is
 * not kept: the turn keeps why, never the text, and no frame carries the secret as it streams.
 */
const SECRET = 'Zq8VtR2mK9xLp4Wd';
const CREDENTIAL_DRAFTS = [
  `Sign in at https://app.example.com/cb?token=${SECRET} to finish.`,
  `The deploy password: ${SECRET} is in the vault.`,
  `Use forge_pat_prd_${'ab12'.repeat(8)} for the call.`,
];

function streamed(chunks: readonly string[]) {
  const frames: unknown[] = [];
  let clock = 0;
  const progress = startConversationProgress({
    conversationId: 'c1',
    entryId: 'e1',
    now: () => (clock += 10_000),
    publish: async (_id, envelope) => {
      frames.push(envelope.data);
      return 1;
    },
  });
  for (const text of chunks) progress.onTurnEvent({ type: 'chunk', text });
  return { progress, frames };
}

/** What a frame shows a reader: the entry's prose, its blocks and any withdrawn draft, never its clock. */
const shown = (frame: unknown) => {
  const f = frame as { entry: { content?: string; blocks?: unknown }; replaced?: unknown };
  return JSON.stringify([f.entry.content, f.entry.blocks, f.replaced ?? null]);
};

/** Every run of the secret the frames could carry: any two of its characters in a row. */
const secretRuns = (secret: string) =>
  Array.from({ length: secret.length - 1 }, (_, i) => secret.slice(i, i + 2));

describe('a draft the reply check reads as a credential', () => {
  it.each(CREDENTIAL_DRAFTS)(
    'keeps why it was withdrawn and none of its text: %s',
    async (draft) => {
      const { progress, frames } = streamed([draft]);
      progress.onSettled({ text: 'I cannot share that here.', screenReplaced: true });
      await progress.close();

      expect(progress.withdrawnDraft()).toBeNull();
      expect(progress.withdrawnFor()).toBe('credential');
      expect(frames.at(-1)).toMatchObject({ replaced: { draft: null, for: 'credential' } });
      expect(progress.blocksForRecord('I cannot share that here.')).toBeNull();
    },
  );

  it('reaches no reader while it streams, one character per frame', async () => {
    const draft = CREDENTIAL_DRAFTS[0] as string;
    const { progress, frames } = streamed(Array.from(draft));
    progress.onSettled({ text: 'I cannot share that here.', screenReplaced: true });
    await progress.close();

    expect(frames.length).toBeGreaterThan(draft.length - 1);
    const sent = frames.map(shown);
    for (const run of secretRuns(SECRET)) expect(sent.filter((s) => s.includes(run))).toEqual([]);
  });

  it('reaches no reader at any point the stream could split it in two', async () => {
    for (const draft of CREDENTIAL_DRAFTS) {
      const secret = draft.includes(SECRET) ? SECRET : 'ab12ab12';
      for (let at = 1; at < draft.length; at += 1) {
        const { progress, frames } = streamed([draft.slice(0, at), draft.slice(at)]);
        await progress.close();
        const sent = frames.map(shown).join('\n');
        for (const run of secretRuns(secret))
          expect(sent.includes(run), `${draft} split at ${at}`).toBe(false);
      }
    }
  });

  // Consult on r43 F1: the scrubber matches a private key's body only once 16 characters of it exist.
  it('shows none of a private key while it streams, one character per frame', async () => {
    const body = 'MIIEowIBAAKCAQEAz9Lp4Wd8VtR2mK9x';
    const draft = `Here it is:\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const { progress, frames } = streamed(Array.from(draft));
    await progress.close();
    const sent = frames.map(shown).join('\n');
    for (const run of secretRuns(body)) expect(sent.includes(run), run).toBe(false);
  });

  // Consult on r43 F2: a tool call splits the prose into two blocks, the key in one and its value in the other.
  it('shows no password whose key and value a tool call split into two blocks', async () => {
    const frames: unknown[] = [];
    const progress = startConversationProgress({
      conversationId: 'c1',
      entryId: 'e1',
      publish: async (_id, envelope) => {
        frames.push(envelope.data);
        return 1;
      },
    });
    progress.onTurnEvent({ type: 'chunk', text: 'The deploy password: ' });
    progress.onTurnEvent({ type: 'tool_call', id: 't1', name: 'forge_issue', arguments: '{}' });
    progress.onTurnEvent({ type: 'chunk', text: `${SECRET} is the one.` });
    progress.onTurnEvent({ type: 'tool_result', id: 't1', result: 'ok' });
    await progress.close();

    expect(frames.length).toBeGreaterThan(1);
    expect(frames.map(shown).join('\n')).not.toContain(SECRET);
  });

  it('keeps no credential in the reasoning stored beside the reply', async () => {
    const frames: unknown[] = [];
    const progress = startConversationProgress({
      conversationId: 'c1',
      entryId: 'e1',
      publish: async (_id, envelope) => {
        frames.push(envelope.data);
        return 1;
      },
    });
    progress.onTurnEvent({
      type: 'reasoning',
      text: `The caller pasted password: ${SECRET} earlier.`,
    });
    progress.onTurnEvent({ type: 'chunk', text: 'Two issues are open.' });
    progress.onSettled({ text: 'Two issues are open.', screenReplaced: false });
    await progress.close();

    expect(JSON.stringify(progress.blocksForRecord('Two issues are open.'))).not.toContain(SECRET);
    expect(frames.map(shown).join('\n')).not.toContain(SECRET);
  });

  it('leaves a draft that held no credential as it was', async () => {
    const { progress, frames } = streamed(['ISS-4242 shipped in v9.2.']);
    progress.onSettled({ text: 'I could not verify that.', screenReplaced: true });
    await progress.close();
    expect(progress.withdrawnDraft()).toBe('ISS-4242 shipped in v9.2.');
    expect(progress.withdrawnFor()).toBeNull();
    expect(frames.at(-1)).toMatchObject({ replaced: { draft: 'ISS-4242 shipped in v9.2.' } });
  });
});
