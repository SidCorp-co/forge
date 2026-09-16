// Criterion 27 — what a project with a connected Google integration gains in
// the pipeline preamble. The subject is `renderIntegrations`, which lives under
// `prompt/facts/`; this test imports it and asserts on the Google row, so the
// assertion sits with the provider it is about and the prompt module is read
// rather than edited.

import { describe, expect, it, vi } from 'vitest';
import { getGuide } from '../../guides/registry.js';
import { getIntegrationGuide, getIntegrationUsage } from '../usage-registry.js';

// `resolve.ts` reaches the DB and the env at import time and none of that is
// what criterion 27 is about; the same three stubs `prompt/facts/resolve.test.ts`
// uses are enough to reach the pure renderer.
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../knowledge/service.js', () => ({
  selectAlwaysInjectFromKnowledge: vi.fn(),
  selectOnDemandSlugsFromKnowledge: vi.fn(),
}));

const { renderIntegrations } = await import('../../prompt/facts/resolve.js');

function googleRow(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'google',
    role: 'service',
    stages: [],
    lastHealthStatus: 'ok',
    hasOrgGuide: false,
    instructions: null,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: the row shape resolve.ts builds from a binding
  } as any;
}

describe('the preamble line a connected Google integration earns', () => {
  it('names forge_google_sheets as the entry tool', () => {
    const rendered = renderIntegrations([googleRow()]);
    expect(rendered).toContain('**google**');
    expect(rendered).toContain('forge_google_sheets');
  });

  it('points at a fetched guide rather than inlining the playbook', () => {
    const rendered = renderIntegrations([googleRow()]);
    expect(rendered).toContain('forge_guide get google-sheets');
    // The router hint is the tier that is injected into EVERY job on a project
    // with this connected, so its length is the thing worth asserting: the
    // playbook belongs behind the pointer above, not in this string.
    expect(getIntegrationUsage('google').length).toBeLessThan(400);
    expect(getIntegrationUsage('google')).not.toContain('client_email (Viewer');
  });

  it('carries the health verdict, so a broken credential is visible in the prompt', () => {
    expect(renderIntegrations([googleRow({ lastHealthStatus: 'needs_scope' })])).toContain(
      'health: needs_scope',
    );
  });

  it('an org override shadows the code guide slug, as for every other provider', () => {
    expect(renderIntegrations([googleRow({ hasOrgGuide: true })])).toContain(
      'forge_guide get integration-google',
    );
  });
});

describe('the capability guide the pointer resolves to', () => {
  it('is served by the code registry under the slug the usage table names', () => {
    expect(getIntegrationGuide('google')).toBe('google-sheets');
    expect(getGuide('google-sheets')).toBeDefined();
  });

  it('carries the sharing rule, which is the failure an operator actually hits', () => {
    expect(getGuide('google-sheets')?.body).toContain('client_email');
  });

  it('carries the overwrite-versus-append distinction and the five refusals', () => {
    const body = getGuide('google-sheets')?.body ?? '';
    expect(body).toContain('`update` overwrites');
    expect(body).toContain('no Google connection on this project');
    expect(body).toContain('Google refused the sheet');
  });

  it('names no credential — it is fetched by agents', () => {
    const body = getGuide('google-sheets')?.body ?? '';
    expect(body).not.toContain('PRIVATE KEY');
    expect(body).not.toContain('serviceAccountJson');
  });
});
