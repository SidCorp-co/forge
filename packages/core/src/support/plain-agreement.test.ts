import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentOpening, supportBrief } from './prompt.js';

// @direct-test-of packages/core/src/support/prompt.ts
// @direct-test-of packages/core/src/support/tool.ts
//
// ISS-1000 (sidpeak, 2026-11-06): the room's release decider answered a proposal with a plain go in
// her own words, and the agent asked her to type a set word before it would cite her. A plain agreement in any
// words is consent (agent-is-the-voice: no "type confirm XXXX" handshake), so neither the room's
// brief nor the agree action's description may teach a set word, and both say so.

/** A sentence telling the agent to make a person type, write or say one set word. */
const SET_WORD = /\b(type|write|say|reply)\b[^.]{0,40}["“'`](confirm|đồng ý|yes|ok|agree)/i; // i18n-allow: the Vietnamese set word the agent demanded
const TEACHES = 'any words of their own are their agreement; never ask anyone to type a set word';

const briefs = [
  supportBrief({ projectName: 'P', product: null, tools: [] }),
  supportBrief({
    projectName: 'P',
    product: null,
    tools: [],
    opening: agentOpening({ projectName: 'P', product: null, channels: ['#g'], ownerMode: true }),
  }),
];

/** The support tool's description as the agent's client is shown it. */
const described = (): string => {
  const tools = JSON.parse(
    readFileSync(new URL('../../contracts/forge-mcp.tools.json', import.meta.url), 'utf8'),
  ) as
    | { tools?: { name: string; description: string }[] }
    | { name: string; description: string }[];
  const list = Array.isArray(tools) ? tools : (tools.tools ?? []);
  const tool = list.find((t) => t.name === 'forge_support');
  if (!tool) throw new Error('forge_support is not in the generated tool contract');
  return tool.description;
};

describe('a plain agreement in any words is consent, never a set word', () => {
  it('the room brief teaches it and demands no word', () => {
    for (const b of briefs) {
      expect(b).toContain(TEACHES);
      expect(b).not.toMatch(SET_WORD);
    }
  });

  it('the agree action says it and demands no word', () => {
    const d = described();
    expect(d).toContain(TEACHES);
    expect(d).not.toMatch(SET_WORD);
  });
});
