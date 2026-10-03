import { describe, expect, it } from 'vitest';
import { autoflowDraftVersion } from './draft.js';

describe('autoflowDraftVersion (ISS-91)', () => {
  it('names the same draft by the same id whatever order its keys arrive in', () => {
    const a = autoflowDraftVersion({ nodes: [{ id: 'n1', type: 'respond' }], edges: [] });
    const b = autoflowDraftVersion({ edges: [], nodes: [{ type: 'respond', id: 'n1' }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('names an edited draft by another id', () => {
    expect(autoflowDraftVersion({ nodes: [{ id: 'n1' }] })).not.toBe(
      autoflowDraftVersion({ nodes: [{ id: 'n2' }] }),
    );
  });
});
