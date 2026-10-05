import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { firstRequirementsVenue } from '../onboarding/first-requirements.js';
import type { ChatToolset } from './tools/mcp-adapter.js';
import {
  fenceToolsetToOrigin,
  handoffPersonSpoke,
  handoffVenueRefusal,
  ONBOARDING_HANDOFF_ACTS,
} from './turn-origin.js';

const ok = (name: string): CallToolResult => ({ content: [{ type: 'text', text: name }] });

function toolset(names: readonly string[]): ChatToolset {
  return {
    tools: names.map((name) => ({
      type: 'function' as const,
      function: { name, description: name, parameters: {} },
    })),
    execute: async (name) => ok(name),
    ranAs: () => 'u1',
  };
}

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe('the onboarding hand-off turn origin (project-onboarding req-case)', () => {
  it('runs only in a first-requirements case room', () => {
    expect(handoffVenueRefusal(firstRequirementsVenue('o1'))).toBeNull();
    for (const venue of ['3f1c', null, 'onboarding:o1']) {
      expect(handoffVenueRefusal(venue)?.code).toBe('TURN_ORIGIN_REFUSED');
    }
  });

  it('is a message turn again once a person spoke in the window', () => {
    expect(handoffPersonSpoke([{ role: 'system', authorUserId: null }])).toBe(false);
    expect(
      handoffPersonSpoke([
        { role: 'system', authorUserId: null },
        { role: 'user', authorUserId: 'p1' },
      ]),
    ).toBe(true);
    expect(handoffPersonSpoke([{ role: 'user', authorUserId: null }])).toBe(false);
  });

  it('offers only the suggestion acts, and refuses any other by name', async () => {
    const all = [...ONBOARDING_HANDOFF_ACTS, 'ba_send_questionnaire', 'forge_cli'];
    const fenced = fenceToolsetToOrigin(toolset(all), 'onboarding_handoff');
    expect(fenced.tools.map((t) => t.function.name)).toEqual([...ONBOARDING_HANDOFF_ACTS]);
    expect(text(await fenced.execute('ba_suggest_requirement', '{}'))).toBe(
      'ba_suggest_requirement',
    );
    for (const other of ['ba_send_questionnaire', 'forge_cli']) {
      const refused = await fenced.execute(other, '{}');
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('TURN_ORIGIN_REFUSED');
      expect(text(refused)).toContain(other);
      expect(fenced.ranAs(other)).toBeNull();
    }
  });

  it('leaves a message turn its whole catalog', () => {
    const set = toolset(['ba_send_questionnaire', 'ba_suggest_requirement']);
    expect(fenceToolsetToOrigin(set, 'message')).toBe(set);
  });
});
