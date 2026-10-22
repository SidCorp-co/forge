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
    corrected.progress.onSettled({ text: 'Two issues are open, both bugs.', screenReplaced: false });
    expect(corrected.progress.withdrawnDraft()).toBeNull();
    await Promise.all([asStreamed.progress.close(), corrected.progress.close()]);
  });
});
