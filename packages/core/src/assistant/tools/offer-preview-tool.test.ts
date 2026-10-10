import { beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-41 BC-15: a change the person asks for in chat reaches the idea preview they have open, and
// one with no open preview is refused by name, with nothing sent.

const state = vi.hoisted(() => ({
  open: null as { id: string } | null,
  sent: [] as { previewId: string; text: string; agency: string }[],
}));
vi.mock('../../previews/index.js', () => ({
  itemOf: async () => null,
  openIdeaPreviewOf: async () => state.open,
  sendPreviewMessage: async (previewId: string, actor: { agency: string }, text: string) => {
    state.sent.push({ previewId, text, agency: actor.agency });
    return { sent: true, seq: 7 };
  },
}));
vi.mock('../../permissions/index.js', () => ({
  actorFor: () => ({}),
  can: async () => true,
  projectResource: () => ({}),
}));

const { buildOfferPreviewToolset } = await import('./offer-preview-tool.js');
const tools = buildOfferPreviewToolset({ projectId: 'p', userId: 'u' });
const change = async (args: unknown) => {
  const r = await tools.execute('preview_change', JSON.stringify(args));
  return {
    isError: r.isError === true,
    text: r.content.map((c) => ('text' in c ? c.text : '')).join(''),
  };
};

describe('preview_change', () => {
  beforeEach(() => {
    state.open = null;
    state.sent.length = 0;
  });

  it('is offered beside offer_preview', () => {
    expect(tools.tools.map((t) => t.function.name)).toEqual(['offer_preview', 'preview_change']);
  });

  it("sends the person's words to their open idea preview, as the assistant acting for them", async () => {
    state.open = { id: 'pv1' };
    const r = await change({ about: 'REQ-41', change: 'make the header blue' });
    expect(r.isError).toBe(false);
    expect(state.sent).toEqual([
      { previewId: 'pv1', text: 'make the header blue', agency: 'agent' },
    ]);
    expect(JSON.parse(r.text).sent).toEqual({ previewId: 'pv1', about: 'REQ-41', seq: 7 });
  });

  it('refuses by name, sending nothing, where no idea preview of that item is open', async () => {
    const r = await change({ about: 'FB-12', change: 'bigger button' });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).error).toMatch(/^IDEA_PREVIEW_NOT_OPEN: .*FB-12.*Nothing was sent/);
    expect(state.sent).toEqual([]);
  });

  it('refuses a key that is not a requirement or feedback item', async () => {
    const r = await change({ about: 'ISS-4', change: 'x' });
    expect(JSON.parse(r.text).error).toMatch(/^IDEA_OFFER_INVALID: about:/);
  });
});
