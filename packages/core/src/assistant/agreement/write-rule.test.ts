// The one chat write rule (REQ-30 BC-4, chat-turn r3 step hold), read by the REST admission, the
// /mcp tool call and the Assistant's gate alike: held where a hold names the write, passed only
// where the one list names it as not a business write, refused by name otherwise. The integration
// suite (`tests/integration/chat-agreement-default-e2e.test.ts`) runs it against the real routes.

import { describe, expect, it } from 'vitest';
import {
  DELEGATES_TO_REST,
  decideRestWrite,
  decideToolCall,
  NOT_A_BUSINESS_WRITE,
  REFUSED_FROM_CHAT,
  refusedWriteText,
} from './write-rule.js';

const rest = (method: string, route: string, heldAs: string | null = null) =>
  decideRestWrite({ method, route, heldAs: heldAs as never });
const familyOf = (v: ReturnType<typeof rest>) => (v.verdict === 'refuse' ? v.family : v.verdict);

describe('a REST write is held, passed or refused, and never let through unnamed', () => {
  it('a read is never asked', () => {
    expect(rest('GET', '/api/issues/:id')).toEqual({ verdict: 'read' });
  });

  it("is held where the route's own hold names its kind", () => {
    expect(rest('POST', '/api/issues/:id/transition', 'issue_change')).toEqual({
      verdict: 'hold',
      kind: 'issue_change',
    });
  });

  it('passes a call the list names as not a business write', () => {
    expect(rest('POST', '/api/memory/search').verdict).toBe('pass');
    expect(rest('POST', '/api/conversations/:id/blocks').verdict).toBe('pass');
  });

  it('refuses each family the judge found written with no card, by its family', () => {
    expect(familyOf(rest('DELETE', '/api/projects/:id'))).toBe('project deletion');
    expect(familyOf(rest('DELETE', '/api/issues/:id'))).toBe('issue deletion');
    expect(familyOf(rest('PUT', '/api/projects/:id/knowledge/:slug'))).toBe('knowledge entry');
    expect(familyOf(rest('PUT', '/api/projects/:id/secrets/:scope/:name'))).toBe('secret write');
    expect(familyOf(rest('POST', '/api/projects/:id/channel/drafts'))).toBe('channel document');
    expect(familyOf(rest('POST', '/api/projects/:projectId/members'))).toBe('membership change');
    expect(familyOf(rest('POST', '/api/projects/:id/requirements/:req/agree'))).toBe(
      'requirement sign-off',
    );
    expect(familyOf(rest('POST', '/api/issues/:id/merge'))).toBe('delivery act');
  });

  it('refuses a write route added later that nobody named, as an unlisted write', () => {
    expect(familyOf(rest('POST', '/api/projects/:id/brand-new-thing'))).toBe('write no list names');
    expect(familyOf(rest('PATCH', '/api/issues/:id', null))).toBe('write no list names');
  });

  it("leaves a route's own refusal of every chat credential to its own name", () => {
    expect(rest('POST', '/api/projects/:id/issues').verdict).toBe('route-refuses');
    expect(rest('POST', '/api/conversations/:id/proposals/:pid/agree').verdict).toBe(
      'route-refuses',
    );
  });

  it('says what was refused, why, and where the person does it instead', () => {
    const v = rest('DELETE', '/api/projects/:id');
    if (v.verdict !== 'refuse') throw new Error('expected a refusal');
    const said = refusedWriteText(v, 'DELETE /api/projects/:id');
    expect(said).toContain('project deletion');
    expect(said).toContain("on the project's settings page");
    expect(said).toContain('nothing was written');
  });
});

describe('a tool call meets the same rule, read from the grant it declares', () => {
  it('holds the record tools and the forge CLI forms that write', () => {
    expect(
      decideToolCall('forge_feedback', '{"kind":"bug","title":"x"}', 'projects:write'),
    ).toEqual({ verdict: 'hold', kind: 'feedback' });
    expect(
      decideToolCall('forge', '{"argv":["issue","ISS-1","--set","priority=low"]}', null),
    ).toEqual({ verdict: 'hold', kind: 'issue_change' });
  });

  it('lets a read through: a read grant, and a record tool asked only to preview', () => {
    expect(decideToolCall('forge_requirements', '{}', 'projects:read').verdict).toBe('read');
    expect(
      decideToolCall('forge_requirement_draft', '{"preview":true}', 'projects:write').verdict,
    ).toBe('read');
  });

  it('passes the CLI form that writes nothing to REST, where the REST half decides each request', () => {
    expect(decideToolCall('forge', '{"argv":["issue","ISS-1"]}', null)).toEqual({
      verdict: 'pass',
      why: DELEGATES_TO_REST.forge,
    });
  });

  it('refuses the channel write, and any write tool that is named nowhere', () => {
    const channel = decideToolCall('forge_channel', '{"action":"draft"}', 'projects:write');
    expect(familyOf(channel)).toBe('channel document');
    expect(familyOf(decideToolCall('forge_brand_new', '{}', 'projects:write'))).toBe(
      'write no list names',
    );
    expect(familyOf(decideToolCall('hand_built_tool', '{}', null))).toBe('write no list names');
  });
});

describe('the list is one list, each entry with its reason, and a REST route and its tool twin agree', () => {
  it('every entry says why it is not a business write, and names something', () => {
    for (const entry of NOT_A_BUSINESS_WRITE) {
      expect(entry.why.length).toBeGreaterThan(10);
      expect(entry.rest.length + entry.tools.length).toBeGreaterThan(0);
      // a PUT, PATCH or DELETE changes a record by its method, so no entry can be one of them
      for (const call of entry.rest) expect(call).toMatch(/^POST \/(api|mcp)\//);
    }
  });

  it('no call is both passed and refused', () => {
    for (const entry of NOT_A_BUSINESS_WRITE) {
      for (const call of entry.rest) {
        const [method = '', route = ''] = call.split(' ');
        expect(rest(method, route).verdict).toBe('pass');
      }
      for (const name of entry.tools) {
        expect(REFUSED_FROM_CHAT.some((f) => f.tools.includes(name))).toBe(false);
      }
    }
  });

  it('a tool and its REST twin on one entry meet the same verdict', () => {
    const show = NOT_A_BUSINESS_WRITE.find((e) => e.tools.includes('forge_show'));
    expect(show?.rest).toContain('POST /api/conversations/:id/blocks');
    expect(decideToolCall('forge_show', '{}', 'assistant:write').verdict).toBe('pass');
    expect(rest('POST', '/api/conversations/:id/blocks').verdict).toBe('pass');
  });
});

/**
 * The list closed (ISS-439 round 4): every call a chat credential's write passes on, written out here
 * with the reason it is not a business write. The round 3 judge added `PUT /api/projects/:id/policy`
 * to the list and 83 unit and 15 e2e tests stayed green; an entry added, widened or reworded now has
 * to be added here too, by someone saying why it writes no record the project works from.
 */
const ALLOWED: readonly { why: string; rest: readonly string[]; tools: readonly string[] }[] = [
  {
    why: 'a search: a read sent as a POST, which writes nothing',
    rest: ['POST /api/memory/search', 'POST /api/projects/:id/knowledge/search'],
    tools: [],
  },
  {
    why: 'a preview: it renders what a write would say and writes nothing',
    rest: ['POST /api/body/preview', 'POST /api/projects/:id/feedback/:fb/messages/preview'],
    tools: [],
  },
  {
    why: 'a report query or template run, kept so the room can cite it; it changes no record the project works from',
    rest: [
      'POST /api/projects/:id/report-queries/:queryId/runs',
      'POST /api/projects/:id/report-templates/:templateId/runs',
      'POST /api/projects/:id/report-templates/:templateId/narrative',
    ],
    tools: [],
  },
  {
    why: 'a computation over the report runs this turn made, on a sandbox; its result is kept for the room and changes no record',
    rest: ['POST /api/projects/:id/executions'],
    tools: ['forge_compute'],
  },
  {
    why: "a block the chat draws into its own room: the chat's own message, never a record",
    rest: ['POST /api/conversations/:id/blocks'],
    tools: ['forge_show'],
  },
  {
    why: "which contracts the session's repository paths call: a read, noted on the asking session",
    rest: ['POST /api/projects/:id/contract-context'],
    tools: [],
  },
  {
    why: 'a suggestion or mockup the BA offers: it changes nothing until a person accepts it on the requirement page',
    rest: [],
    tools: ['ba_suggest', 'ba_suggest_requirement', 'ba_draw_mockup'],
  },
  {
    why: 'an ask to the person in this room, through the questionnaire card',
    rest: [],
    tools: ['ba_send_questionnaire', 'ba_ask_clarification'],
  },
  {
    why: "it moves the person's own screen, or offers them a button they press as themselves; it writes nothing",
    rest: [],
    tools: [
      'ui_navigate',
      'ui_issues_filter',
      'ui_select',
      'ui_open',
      'ui_board_draw',
      'ui_board_revise',
      'offer_act',
    ],
  },
  {
    why: "a read of this room's own past",
    rest: [],
    tools: ['rocketchat_history', 'rocketchat_quote_context', 'conversation_transcript_search'],
  },
  {
    why: 'it hands this turn to a box session, whose own writes meet this rule',
    rest: [],
    tools: ['escalate'],
  },
];

describe('the not-a-business-write list is closed', () => {
  it('holds exactly the calls written out here, each with its reason', () => {
    expect(
      NOT_A_BUSINESS_WRITE.map((e) => ({ why: e.why, rest: [...e.rest], tools: [...e.tools] })),
    ).toEqual(ALLOWED);
  });

  it('refuses the business write the judge planted, the project policy, as no list names it', () => {
    expect(familyOf(rest('PUT', '/api/projects/:id/policy'))).toBe('write no list names');
  });
});
