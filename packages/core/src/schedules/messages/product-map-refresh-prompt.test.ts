import { describe, expect, it } from 'vitest';
import {
  MAX_NEW_ENTRIES_PER_RUN,
  buildProductMapRefreshPrompt,
} from './product-map-refresh-prompt.js';

const PROJECT_ID = '9f6cd30a-c93a-43de-b171-56e5ef716388';

describe('buildProductMapRefreshPrompt', () => {
  it('embeds the projectId and the per-run cap', () => {
    const p = buildProductMapRefreshPrompt({ projectId: PROJECT_ID, mode: 'auto' });
    expect(p).toContain(PROJECT_ID);
    expect(p).toContain(String(MAX_NEW_ENTRIES_PER_RUN));
  });

  it('auto mode → instructs upsert directly', () => {
    const p = buildProductMapRefreshPrompt({ projectId: PROJECT_ID, mode: 'auto' });
    expect(p).toContain('auto = upsert');
    expect(p).toContain('forge_knowledge action=upsert');
  });

  it('propose mode → DRY-RUN, writes nothing', () => {
    const p = buildProductMapRefreshPrompt({ projectId: PROJECT_ID, mode: 'propose' });
    expect(p).toContain('DRY-RUN');
    expect(p).toMatch(/do NOT call forge_knowledge upsert/i);
  });

  it('carries the verification gate (user-facing only, no source identifiers)', () => {
    const p = buildProductMapRefreshPrompt({ projectId: PROJECT_ID, mode: 'auto' });
    expect(p).toContain('Verification gate');
    expect(p).toContain('file:line');
    expect(p).toMatch(/never downgrade/i);
  });

  it('is NOT the steward — must not emit the steward report sentinel', () => {
    const p = buildProductMapRefreshPrompt({ projectId: PROJECT_ID, mode: 'auto' });
    expect(p).toMatch(/do NOT emit the steward-report/i);
  });
});
