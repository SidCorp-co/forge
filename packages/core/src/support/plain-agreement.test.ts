import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { servedGuideBody } from '../guides/index.js';
import { ROOM_AGENT_GUIDE } from '../guides/room-agent-guide.js';
import { provideDoorCatalog } from '../lib/door-catalog.js';
import { servedDoorCatalog } from '../mcp/door-catalog.js';
import { actionCatalog } from '../mcp/action-catalog.js';
import { agentOpening, supportBrief } from './prompt.js';
import { forgeSupportTool } from './tool.js';

// ISS-1251: the brief is a map naming the room agent's guide, where each line's detail now lives;
// what the agent is taught is the brief and that guide as served, the agree card beneath its body
provideDoorCatalog({ doorCatalog: servedDoorCatalog, doorCalls: async () => new Map() });
const GUIDE = servedGuideBody(ROOM_AGENT_GUIDE);
const taught = (b: string): string => {
  expect(b).toContain('support.guide {}');
  return `${b}\n\n${GUIDE}`;
};

// @direct-test-of packages/core/src/support/prompt.ts
// @direct-test-of packages/core/src/support/tool.ts
//
// ISS-1000 (sidpeak, 2026-11-06): the room's release decider answered a proposal with a plain go in
// her own words, and the agent asked her to type a set word before it would cite her. A plain agreement in any
// words is consent (agent-is-the-voice: no "type confirm XXXX" handshake), so neither the room's
// brief nor the agree action's description may teach a set word, and both say so.

/** A sentence telling the agent to make a person type, write or say one set word. */
const SET_WORD = /\b(type|write|say|reply)\b[^.]{0,40}["“'`](confirm|đồng ý|yes|ok|agree)/i; // i18n-allow: the Vietnamese set word the agent demanded
/** The agree card's line, the one text teaching the act to the room agent (ISS-1251). */
const CARD_TEACHES = 'Any words of their own agree; never ask anyone to type a set word';

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
      expect(taught(b)).toContain(CARD_TEACHES);
      expect(b).not.toMatch(SET_WORD);
    }
  });

  it('the agree action says it and demands no word', () => {
    const d = described();
    // the act's entry is its card's purpose, and forge_describe answers the card beside it (ISS-1251)
    const tool = forgeSupportTool({
      principal: { userId: 'u', tokenId: 't', projectIds: ['p'], boundProjectId: null },
    } as never);
    const card = actionCatalog([tool]).get('support.agree')?.card;
    expect(card?.practice.some((line) => line.includes(CARD_TEACHES))).toBe(true);
    expect(d).toContain('agree { thread, proposal, message, decision?: agree | decline }:');
    expect(d).not.toMatch(SET_WORD);
  });
});
