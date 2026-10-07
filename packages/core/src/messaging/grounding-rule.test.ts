import { describe, expect, it } from 'vitest';
import { cellFor } from './cells.js';
import { facts } from './facts.js';
import { GROUNDING_TOOLS, STATUS_CLAIMS_GROUNDED } from './grounding-rule.js';
import { screenAtDoor } from './screen.js';

// JU-1: the project assistant answered status, progress, release, roadmap, lateness and decision
// questions from issue counts and memory, and was wrong. Each reply below is the opening sentence
// of a recorded answer from 2026-10-07 (journey-understand asks f2..f7, h2..h7), the turn that wrote
// it calling only the forge CLI, forge_memory and forge_knowledge.

const OFFERED = ['forge', 'forge_knowledge', 'forge_memory', ...Object.values(GROUNDING_TOOLS)];
const call = (name: string, isError = false) => ({ name, arguments: '{}', isError });
const memoryOnly = [call('forge'), call('forge_memory'), call('forge_knowledge')];

const RECORDED: { ask: string; reply: string; family: string }[] = [
  {
    ask: 'f3',
    reply: 'There are no requirements currently in progress.',
    family: "a requirement's progress",
  },
  {
    ask: 'h3',
    reply: 'Hiện toàn dự án có 39 yêu cầu in_progress.', // i18n-allow: a recorded Vietnamese reply replayed against the rule
    family: "a requirement's progress",
  },
  {
    ask: 'f2',
    reply: '0.4.0-dev.112 — also shipped with the same underlying fix commit present.',
    family: 'what shipped or was released',
  },
  { ask: 'h2', reply: '0.2.0 Chờ phê duyệt để hoàn tất.', family: 'what shipped or was released' }, // i18n-allow: a recorded Vietnamese reply replayed against the rule
  {
    ask: 'h7',
    reply: 'HOP has shipped 79 items to the release branch, with 39 currently in progress.',
    family: 'what shipped or was released',
  },
  {
    ask: 'f5',
    reply: 'There is no dated, committed roadmap currently recorded.',
    family: 'what comes next and when',
  },
  {
    ask: 'h5',
    reply: 'Release kế tiếp hiện chưa có ngày ETA được ghi nhận.', // i18n-allow: a recorded Vietnamese reply replayed against the rule
    family: 'what comes next and when',
  },
  {
    ask: 'f4',
    reply: 'No due dates are set, so nothing is late.',
    family: 'what is late or blocked',
  },
  {
    ask: 'f6',
    reply: 'This week’s notable requirements/design decisions were: requirements are first-class.',
    family: 'what was decided',
  },
  {
    ask: 'h6',
    reply: 'Các quyết định đáng chú ý gần đây: giao diện theo mockup.', // i18n-allow: a recorded Vietnamese reply replayed against the rule
    family: 'what was decided',
  },
];

describe('a status claim with no read behind it', () => {
  it.each(RECORDED)('refuses $ask, naming the claim and the read to call', ({ reply, family }) => {
    const broke = STATUS_CLAIMS_GROUNDED.check(
      reply,
      facts({ toolCalls: memoryOnly, offeredTools: OFFERED }),
    );
    expect(broke.length).toBeGreaterThan(0);
    expect(broke[0]?.why).toContain(`the reply states ${family}`);
    expect(broke[0]?.why).toMatch(/call forge_(?:project_status|requirements|releases|decisions)/);
  });

  it('passes the same reply once forge_project_status answered this turn', () => {
    for (const { reply, family } of RECORDED) {
      const tool = family === 'what was decided' ? 'forge_decisions' : 'forge_project_status';
      expect(
        STATUS_CLAIMS_GROUNDED.check(
          reply,
          facts({ toolCalls: [...memoryOnly, call(tool)], offeredTools: OFFERED }),
        ),
        reply,
      ).toEqual([]);
    }
  });

  it('holds a refused read to nothing: the call happened and grounded no claim', () => {
    const broke = STATUS_CLAIMS_GROUNDED.check(
      RECORDED[0]?.reply ?? '',
      facts({ toolCalls: [call('forge_project_status', true)], offeredTools: OFFERED }),
    );
    expect(broke).toHaveLength(1);
  });

  it('grounds a release claim on forge_releases but not on forge_decisions', () => {
    const reply = 'Release 0.2.0 was released to users yesterday.';
    const on = (tool: string) =>
      STATUS_CLAIMS_GROUNDED.check(
        reply,
        facts({ toolCalls: [call(tool)], offeredTools: OFFERED }),
      );
    expect(on('forge_releases')).toEqual([]);
    expect(on('forge_decisions')).toHaveLength(1);
  });

  it('does not judge a turn offered none of the reads (agent mode, a door without them)', () => {
    expect(
      STATUS_CLAIMS_GROUNDED.check(
        RECORDED[0]?.reply ?? '',
        facts({ toolCalls: memoryOnly, offeredTools: ['forge', 'forge_memory'] }),
      ),
    ).toEqual([]);
  });

  it('leaves a reply that states no status alone', () => {
    for (const reply of [
      'I filed it as a draft; tell me if the title needs a change.',
      'The change you asked about is done.',
      'Forge is a development-work orchestration platform.',
    ]) {
      expect(
        STATUS_CLAIMS_GROUNDED.check(reply, facts({ toolCalls: [], offeredTools: OFFERED })),
        reply,
      ).toEqual([]);
    }
  });

  it('is read at the web chat door and the chat-sync door, refusing by its own id', () => {
    for (const door of ['web-chat-reply', 'chat-sync'] as const) {
      const verdict = screenAtDoor(
        door,
        ['There are no requirements currently in progress.'],
        facts({ toolCalls: memoryOnly, offeredTools: OFFERED }),
      );
      expect(verdict.ok, door).toBe(false);
      if (!verdict.ok)
        expect(verdict.refusals.map((r) => r.rule)).toContain('status-claims-grounded');
    }
  });

  it('passes every other rule example in the cells it sits in', () => {
    for (const cell of [cellFor('role', 'chat'), cellFor('public', 'report')]) {
      for (const rule of cell?.rules ?? []) {
        expect(
          STATUS_CLAIMS_GROUNDED.check(rule.example, facts({ offeredTools: OFFERED })),
          rule.id,
        ).toEqual([]);
      }
    }
  });
});
