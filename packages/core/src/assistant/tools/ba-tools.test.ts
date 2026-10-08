import { describe, expect, it } from 'vitest';
import type { McpContext } from '../../lib/tool.js';
import { buildBaFirstRequirementsToolset } from './ba-first-tools.js';
import { buildBaToolset } from './ba-tools.js';

// REQ-30 BC-3. forge-dev 0.4.0-dev.193: ba_suggest's description ran 1181 characters, past the
// adapter's 1024 cap, so its last sentence ("baseRevision is the currentRevision you read, null
// when there is none") never reached the model, which sent the draft it read (1) and was refused
// SUGGESTION_BASE_STALE on REQ-31 and REQ-36; and read `readiness` as a key of a revision_diff.
const PROJECT = '11111111-1111-4111-8111-111111111111';
const ctx = {
  principal: {
    kind: 'pat',
    agency: 'human',
    userId: 'u1',
    tokenId: 't1',
    scopes: [],
    projectIds: [PROJECT],
    boundProjectId: PROJECT,
    permissions: ['*'],
    grantEpoch: 1,
    deviceId: null,
    agentUserId: null,
  },
  boundProjectId: PROJECT,
} as unknown as McpContext;
const room = { projectId: PROJECT, requirementId: '22222222-2222-4222-8222-222222222222' };
const ba = buildBaToolset(ctx, room).tools;
const first = buildBaFirstRequirementsToolset(ctx, {
  projectId: PROJECT,
  onboardingId: '33333333-3333-4333-8333-333333333333',
}).tools;
const byName = (name: string) => ba.find((t) => t.function.name === name)?.function;

describe('the BA door as the model is shown it', () => {
  it('offers every tool its whole description, none cut at the cap', () => {
    for (const t of [...ba, ...first])
      expect(t.function.description, t.function.name).not.toContain('[truncated]');
  });

  it('asks the model for no base: ba_suggest takes kind, payload and issue only', () => {
    const params = byName('ba_suggest')?.parameters as { properties?: object } | undefined;
    expect(Object.keys(params?.properties ?? {}).sort()).toEqual(['issue', 'kind', 'payload']);
  });

  it('says readiness is a kind of its own, never a key of revision_diff', () => {
    expect(byName('ba_suggest')?.description).toContain('never a key of revision_diff');
  });

  it('shows ba_draw_mockup each shape with its fields, in a schema the provider takes', () => {
    const schema = JSON.stringify(byName('ba_draw_mockup')?.parameters);
    expect(schema).toContain('"const":"arrow"');
    expect(schema).toContain('"const":"text"');
    expect(schema).not.toContain('"const":"pen"');
    expect(schema).not.toContain('oneOf');
    expect(schema).not.toContain('prefixItems');
  });
});
