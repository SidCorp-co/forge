// @direct-test-of packages/core/src/support/master-ask.ts
// @direct-test-of packages/core/src/guides/room-agent-guide.ts
// @direct-test-of packages/core/src/guides/dispatch-guide.ts
// @direct-test-of packages/core/src/support/room-cards.ts
// ISS-1484 (REQ-107 BC-3, BC-4; owner ruling 2026-11-28): a case is decided by its impact, against a
// written list of permitted categories, and a decision the owner agrees in the technical group is kept
// as a precedent the agent and master read. The list and the precedents are project knowledge rules:
// what is taught is where each is read and how each is written, in the text each reader acts on.

import {
  SUPPORT_LOW_IMPACT_SLUG,
  SUPPORT_PRECEDENT_PREFIX,
} from '@forge/contracts/support-master-ask';
import { describe, expect, it } from 'vitest';
import { DISPATCH_GUIDE } from '../guides/dispatch-guide.js';
import { servedGuideBody } from '../guides/index.js';
import { ROOM_AGENT_GUIDE } from '../guides/room-agent-guide.js';
import { provideDoorCatalog } from '../lib/door-catalog.js';
import { servedDoorCatalog } from '../mcp/door-catalog.js';
import { actCard } from './act-cards.js';
import { masterAnsweredNote } from './master-ask.js';

provideDoorCatalog({ doorCatalog: servedDoorCatalog, doorCalls: async () => new Map() });
const flat = (s: string) => s.split(/\s+/).join(' ');
const AGENT = flat(servedGuideBody(ROOM_AGENT_GUIDE));
const MASTER = flat(DISPATCH_GUIDE.body);

describe('a case is decided by its impact, against a written list and the owner’s precedents', () => {
  it('names the list and the precedents by one slug each', () => {
    expect(SUPPORT_LOW_IMPACT_SLUG).toBe('low-impact-cases');
    expect(SUPPORT_PRECEDENT_PREFIX).toBe('precedent-');
  });

  it('teaches the agent: read both first, decide a listed case with the master, bring the rest as options', () => {
    expect(AGENT).toContain(`knowledge:${SUPPORT_LOW_IMPACT_SLUG}`);
    expect(AGENT).toContain(`${SUPPORT_PRECEDENT_PREFIX}<topic>`);
    expect(AGENT).toContain('a case the list names is low impact');
    expect(AGENT).toContain('options and your recommendation');
    expect(AGENT).toContain('rule.write');
    expect(AGENT).toContain('never from your own say-so');
  });

  it('teaches the master: the same list, the same precedents, and never the list grown by itself', () => {
    expect(MASTER).toContain(`\`${SUPPORT_LOW_IMPACT_SLUG}\``);
    expect(MASTER).toContain(`\`${SUPPORT_PRECEDENT_PREFIX}*\``);
    expect(MASTER).toContain('only the owner’s agreement writes either');
  });

  it('hands both to the agent in the note a master’s answer returns as', () => {
    const note = masterAnsweredNote('Is the drive back?', 'Still read-only at 17:05.');
    expect(note).toContain(`knowledge:${SUPPORT_LOW_IMPACT_SLUG}`);
    expect(note).toContain(`${SUPPORT_PRECEDENT_PREFIX}`);
  });

  it('puts the owner’s agreement on the ask_owner card', () => {
    expect(actCard('ask_owner').practice.join(' ')).toContain('precedent');
  });
});
