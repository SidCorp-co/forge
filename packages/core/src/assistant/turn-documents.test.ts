import { describe, expect, it } from 'vitest';
import type { ConversationImage, RoomDocument } from '../conversations/index.js';
import type { ConversationTurn } from './conversation-turn.js';
import { toProviderMessages } from './conversation-turn.js';
import { DOCUMENT_BUDGET_TOKENS, documentBlock, resolveTurnDocuments } from './turn-documents.js';
import { resolveVisionImages } from './vision.js';

const file = (name: string, mime = 'text/markdown'): ConversationImage => ({
  name,
  mime,
  ref: `/api/conversations/c/attachments/${name}/download`,
});
const text = (t: string): Extract<RoomDocument, { ok: true }> => ({
  ok: true,
  name: 'x',
  mime: 'text/markdown',
  text: t,
  redacted: false,
});

describe('a document shown to the model', () => {
  it('is shown whole, under its file name, when it fits', () => {
    const { block } = documentBlock(file('spec.md'), text('- one\n- two'), 1000);
    expect(block).toContain('[Attached document: spec.md (text/markdown)');
    expect(block).toContain('cite it by its file name');
    expect(block).toContain('<document name="spec.md">\n- one\n- two\n</document>');
    expect(block).not.toContain('is cut here');
  });

  it('is cut at a line past the budget, and the cut is stated with the line it stops at', () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `- criterion ${i + 1} reads as the owner wrote it`,
    );
    const { block, tokens } = documentBlock(file('long.md'), text(lines.join('\n')), 500);
    expect(tokens).toBeLessThanOrEqual(500);
    const cut =
      /\[long\.md is cut here: you were shown the first ~[\d,]+ of its ~[\d,]+ tokens \(lines 1–(\d+) of 400\)/.exec(
        block,
      );
    expect(cut, block.slice(-400)).not.toBeNull();
    const shownTo = Number(cut?.[1]);
    expect(block).toContain(`- criterion ${shownTo} reads`);
    expect(block).not.toContain(`- criterion ${shownTo + 1} reads`);
    expect(block).toContain(`stops at line ${shownTo}`);
  });

  it('says a redaction and an unreadable file rather than hiding either', () => {
    expect(
      documentBlock(file('env.md'), { ...text('KEY=[Filtered]'), redacted: true }, 100).block,
    ).toContain('Secret-shaped values in it were redacted');
    expect(
      documentBlock(
        file('gone.pdf', 'application/pdf'),
        { ok: false, reason: 'its bytes could not be read' },
        100,
      ).block,
    ).toContain(
      'gone.pdf (application/pdf) could not be read this turn: its bytes could not be read',
    );
  });

  it('fills one budget newest first, and names an older document it had no room left for', async () => {
    const big = 'x'.repeat(DOCUMENT_BUDGET_TOKENS * 4);
    const shown = await resolveTurnDocuments(
      [{ images: [file('old.md')] }, { images: [file('new.md')] }],
      async () => text(big),
    );
    expect(shown.get(file('new.md').ref)).toContain('<document name="new.md">');
    expect(shown.get(file('old.md').ref)).toContain(
      'old.md (text/markdown), ~24,000 tokens, is not shown this turn',
    );
  });

  it('reaches the model inside the message that carried it, even one with no text of its own', async () => {
    const doc = file('criteria.md');
    const turn: ConversationTurn = {
      conversationId: 'c',
      handleUserId: null,
      history: [],
      pending: [
        {
          role: 'user',
          content: '',
          authorUserId: null,
          authorLabel: null,
          images: [doc],
          silenceReason: null,
        },
      ],
    };
    const docs = await resolveTurnDocuments(turn.pending, async () =>
      text('- The panel opens wide.'),
    );
    const [said] = toProviderMessages(turn, new Map(), docs);
    expect(said?.role).toBe('user');
    expect(String(said?.content)).toContain(
      '<document name="criteria.md">\n- The panel opens wide.\n</document>',
    );
  });

  it('is never sent to the model as a picture', async () => {
    const resolved = await resolveVisionImages(
      [{ images: [file('spec.pdf', 'application/pdf'), file('shot.png', 'image/png')] }],
      [],
      async () => 'AAAA',
    );
    expect([...resolved.keys()]).toEqual([file('shot.png', 'image/png').ref]);
  });
});
