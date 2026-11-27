// @direct-test-of packages/core/src/support/ops-prompt.ts
// @direct-test-of packages/core/src/support/room-cards.ts
// @direct-test-of packages/core/src/support/master-ask.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { servedGuideBody } from '../guides/index.js';
import { ROOM_AGENT_GUIDE } from '../guides/room-agent-guide.js';
import { provideDoorCatalog } from '../lib/door-catalog.js';
import { servedDoorCatalog } from '../mcp/door-catalog.js';
import { actCard, SUPPORT_ACT_CARDS } from './act-cards.js';
import { operationsBrief } from './ops-prompt.js';
import { supportBrief } from './prompt.js';

// ISS-1475 (owner 2026-11-26): a thread is never told "it is in hand". A reaction acknowledges and ONE
// message follows when done. The judge of dev.843 failed two criteria because cards and answers still
// taught the holding line beside a guide that forbade it: this sweeps every text an agent reads.
const HOLDING = [/in hand\b/i, /done or in hand/i, /one short line that it/i];

/** The name of each text that teaches a holding line, with the phrase it holds. */
function holdingLines(texts: Record<string, string>): string[] {
  return Object.entries(texts).flatMap(([name, body]) =>
    HOLDING.filter((re) => re.test(body)).map((re) => `${name}: ${re}`),
  );
}

provideDoorCatalog({ doorCatalog: servedDoorCatalog, doorCalls: async () => new Map() });

const role = { name: 'ops', persona: 'You are ops.', grants: ['read'] } as unknown as Parameters<
  typeof operationsBrief
>[0]['role'];

// the files whose string literals are act answers or scenarios an agent reads; comments are not
const ANSWER_FILES = [
  'support/act-deny.ts',
  'support/master-ask.ts',
  'support/ops-role.ts',
  'support/permission-talk.ts',
  'support/rest-cards.ts',
  'support/room-cards.ts',
  'support/technical-channel.ts',
  'mcp/scenarios-room.ts',
  'mcp/scenarios-support.ts',
];
const code = (file: string): string =>
  readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

const served = (): Record<string, string> => ({
  'the room agent guide': servedGuideBody(ROOM_AGENT_GUIDE),
  'the room brief': supportBrief({ projectName: 'P', product: null, tools: [] }),
  'the operations brief': operationsBrief({ role, scope: 'org', reach: [] }),
  ...Object.fromEntries(
    Object.entries(SUPPORT_ACT_CARDS).map(([act, card]) => [
      `the card of support.${act}`,
      JSON.stringify(card),
    ]),
  ),
  ...Object.fromEntries(ANSWER_FILES.map((f) => [`the answer texts of ${f}`, code(f)])),
});

describe('no served text teaches a holding line (ISS-1475)', () => {
  it('fails, naming the text, on a card that still says it is in hand', () => {
    expect(
      holdingLines({
        'the card of support.route': 'tell the thread it is in hand',
        'the operations brief': 'the thread hears one short line that it is in hand',
        fine: 'react with support.react and post ONE message when done',
      }),
    ).toEqual([
      'the card of support.route: /in hand\\b/i',
      'the operations brief: /in hand\\b/i',
      'the operations brief: /one short line that it/i',
    ]);
  });

  it('holds for the guide, the briefs, every act card and every act answer text', () => {
    expect(holdingLines(served())).toEqual([]);
  });

  it('teaches a reaction and one message in the ask_master and route cards', () => {
    expect(actCard('ask_master').situations[0]?.do).toContain(
      'react with support.react, then post ONE message when done',
    );
    expect(JSON.stringify(actCard('route'))).toContain(
      'react to the asker’s message with support.react and post ONE message when the answer is in',
    );
  });
});
