// Covers the standing-template prompt selection extracted from
// `dispatchScheduleRun` (ISS-579). Kept out of dispatch.test.ts on purpose: the
// selection is pure, so proving it needs none of that file's device / session /
// broadcast harness.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const { resolveTemplatePrompt } = await import('./dispatch.js');

const PROJECT_ID = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';

function schedule(over: Record<string, unknown> = {}) {
  return {
    id: 'sch-1',
    projectId: PROJECT_ID,
    prompt: 'RAW_PROMPT',
    templateKey: null as string | null,
    mode: 'propose' as const,
    appliedMessageVersions: null,
    ...over,
  };
}

describe('resolveTemplatePrompt', () => {
  it('passes a template-less schedule its own prompt through untouched', () => {
    expect(resolveTemplatePrompt(schedule())).toEqual({ prompt: 'RAW_PROMPT', standing: false });
  });

  it('routes each standing key to a DIFFERENT prompt, so no key silently shares another builder', () => {
    const keys = [
      'knowledge-drift-check',
      'product-map-refresh',
      'feedback-triage-digest',
      'ux-contract-improve',
      'optimize-skills',
    ];
    const prompts = keys.map(
      (templateKey) => resolveTemplatePrompt(schedule({ templateKey }))?.prompt as string,
    );

    expect(new Set(prompts).size).toBe(keys.length);
  });

  it('ux-contract-improve gets the improver prompt, not the steward fallback', () => {
    const improver = resolveTemplatePrompt(schedule({ templateKey: 'ux-contract-improve' }));
    const steward = resolveTemplatePrompt(schedule({ templateKey: 'optimize-skills' }));

    expect(improver?.standing).toBe(true);
    expect(improver?.prompt).toContain('UX-contract improver');
    expect(improver?.prompt).not.toBe(steward?.prompt);
  });

  it('ignores appliedMessageVersions for a standing key — every cadence tick dispatches', () => {
    const result = resolveTemplatePrompt(
      schedule({
        templateKey: 'ux-contract-improve',
        appliedMessageVersions: { 'ux-contract-improve': 1 },
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.standing).toBe(true);
  });

  it("falls back to the template's own default mode when the schedule has none", () => {
    const defaulted = resolveTemplatePrompt(
      schedule({ templateKey: 'ux-contract-improve', mode: null }),
    );
    const explicit = resolveTemplatePrompt(
      schedule({ templateKey: 'ux-contract-improve', mode: 'auto' }),
    );

    expect(defaulted?.prompt).toContain('Mode: propose');
    expect(explicit?.prompt).toContain('Mode: auto');
  });

  it('returns null for a ONE-SHOT template already applied at its current version', () => {
    expect(
      resolveTemplatePrompt(
        schedule({ templateKey: 'not-in-registry', appliedMessageVersions: null }),
      ),
    ).toBeNull();
  });
});
