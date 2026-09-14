/**
 * Can a chat door actually READ a guide, and only read one?
 *
 * ISS-1007 moves the assistant's method out of a channel persona and into a
 * guide, which is strictly worse than the prose it replaces unless the tool that
 * fetches it is reachable from the door. So the reach is proved through the same
 * `buildToolset` the routes call, with the guide registry real: a test that
 * asserted the allowlist merely CONTAINS a string would be a claim about an
 * array, not about whether the model can fetch anything.
 */

import { describe, expect, it, vi } from 'vitest';

// cm:guard the two mocks stand in for a parsed environment and a database connection, and the third for the org lookup that would need one — never for the guide registry: `resolveGuide` reaches `getCodeGuide` directly for any slug outside the `integration-` prefix, so the body this test reads back is the real `ASSISTANT_METHOD_GUIDE` and the real `buildToolset` dispatch that fetched it.
vi.mock('../../config/env.js', () => ({ env: {} }));
// cm:guard the stub answers the ONE query the org tier makes — `integration_guides` for this org — with no rows, which is the state of every org that has authored no integration guide. The code tier `resolveGuide` returns is not reached through it: `providerFromGuideSlug` sends any slug outside the `integration-` prefix straight to the real registry.
vi.mock('../../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
}));
vi.mock('../../projects/service.js', () => ({
  findProjectOrgId: async () => '11111111-1111-4111-8111-111111111111',
}));

import { ASSISTANT_METHOD_SLUG } from '../../guides/assistant-method-guide.js';
import { buildChatToolContext } from './principal.js';
import { buildProjectToolset } from './registry.js';

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

const toolset = () =>
  buildProjectToolset(
    buildChatToolContext({ userId: USER_ID, projectId: PROJECT_ID, projectSlug: 'measurement' }),
  );

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((b) => (b.type === 'text' ? (b.text ?? '') : JSON.stringify(b))).join('\n');

describe('reaching the assistant-method guide from a chat door', () => {
  it('offers forge_guide in the tools the model is given', () => {
    const names = toolset().tools.map((t) => t.function.name);
    expect(names).toContain('forge_guide');
  });

  it('returns the guide body for action=get on the method slug', async () => {
    const result = await toolset().execute(
      'forge_guide',
      JSON.stringify({ action: 'get', slug: ASSISTANT_METHOD_SLUG }),
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result as never);
    expect(text).toContain('INVESTIGATE before answering');
    expect(text).toContain('ISSUE QUALITY CONTRACT');
    expect(text).toContain('ACT, do not delegate');
  });

  it('lists the method guide in the index the model can browse', async () => {
    const result = await toolset().execute('forge_guide', JSON.stringify({ action: 'list' }));
    expect(result.isError).toBeFalsy();
    expect(textOf(result as never)).toContain(ASSISTANT_METHOD_SLUG);
  });

  // cm:guard the refusal is asserted on the RESULT rather than on the spec, because the spec is what `registry-allowlist.test.ts` freezes and this file owes the other half: that the fence actually fires at call time, ahead of `assertOrgAdmin`, for a principal the handler's own check might have let through (ISS-1007).
  it('refuses upsert at the door, naming what a room may do instead', async () => {
    const result = await toolset().execute(
      'forge_guide',
      JSON.stringify({
        action: 'upsert',
        provider: 'epodsystem',
        title: 'x',
        summary: 'y',
        body: 'z',
      }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toContain('is not permitted in chat');
    expect(textOf(result as never)).toContain('list, get');
  });

  it('refuses delete at the door', async () => {
    const result = await toolset().execute(
      'forge_guide',
      JSON.stringify({ action: 'delete', provider: 'epodsystem' }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toContain('is not permitted in chat');
  });

  it('names the valid slugs when the model guesses one that does not exist', async () => {
    const result = await toolset().execute(
      'forge_guide',
      JSON.stringify({ action: 'get', slug: 'no-such-guide' }),
    );
    expect(result.isError).toBe(true);
    const text = textOf(result as never);
    expect(text).toContain('NOT_FOUND');
    expect(text).toContain(ASSISTANT_METHOD_SLUG);
  });
});
