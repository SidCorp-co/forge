// @direct-test-of packages/core/src/support/kept-cases.ts
// @direct-test-of packages/core/src/support/keep-cards.ts
// @direct-test-of packages/core/src/guides/room-agent-guide.ts
// ISS-1485 (REQ-107 BC-5; owner ruling 2026-11-28): what the room agent kept is handed to it in the
// turn by relevance, within a stated size, and never as a precedent. The ranking is the find door's;
// what is proven here is what core keeps of it and hands over.

import {
  SUPPORT_KEPT_NOTE_MAX_CHARS,
  SUPPORT_KEPT_NOTE_MAX_ENTRIES,
  SUPPORT_KEPT_PREFIX,
} from '@forge/contracts/support-keep';
import { describe, expect, it } from 'vitest';
import { servedGuideBody } from '../guides/index.js';
import { ROOM_AGENT_GUIDE } from '../guides/room-agent-guide.js';
import { provideDoorCatalog } from '../lib/door-catalog.js';
import { servedDoorCatalog } from '../mcp/door-catalog.js';
import { actCard } from './act-cards.js';
import { keptCasesNote } from './kept-cases.js';

provideDoorCatalog({ doorCatalog: servedDoorCatalog, doorCalls: async () => new Map() });

const room = { projectId: '00000000-0000-4000-8000-000000000001', principalUserId: 'u1' };
const record = (key: string, text: string, title = key) => ({
  type: 'knowledge' as const,
  ref: key,
  key,
  title,
  text,
});
/** A finder that ranks only what bears on the words, as the find door does. */
const finderOf =
  (all: ReturnType<typeof record>[]) =>
  async (input: { query: string }) =>
    all.filter((r) => input.query.toLowerCase().includes(r.title.toLowerCase().split(' ')[0] ?? ''));

describe('what the agent kept is handed to a turn by relevance', () => {
  const all = [
    record(`${SUPPORT_KEPT_PREFIX}export-size`, 'Export drops size without variants; the master fixed it.', 'export drops size'),
    record(`${SUPPORT_KEPT_PREFIX}label-print`, 'Label print needs the printer profile.', 'label print'),
  ];

  it('hands a kept summary that bears on the messages (happy)', async () => {
    const note = await keptCasesNote(room, 'the export loses a column again', finderOf(all));
    expect(note).toContain('Export drops size without variants');
    expect(note).toContain(`${SUPPORT_KEPT_PREFIX}export-size`);
    expect(note).not.toContain('printer profile');
  });

  it('hands nothing where none bears on it (negative)', async () => {
    expect(await keptCasesNote(room, 'how do I reset my password', finderOf(all))).toBeNull();
    expect(await keptCasesNote(room, '   ', finderOf(all))).toBeNull();
  });

  it('never hands an entry that is not a kept summary, a precedent included (boundary)', async () => {
    const other = [
      record('precedent-export', 'The owner agreed: refund it.', 'export precedent'),
      record('release-notes', 'Export notes.', 'export notes'),
    ];
    expect(await keptCasesNote(room, 'export', finderOf(other))).toBeNull();
  });

  it('stays under its stated cap however many and however long (extreme)', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      record(`${SUPPORT_KEPT_PREFIX}export-${i}`, 'x'.repeat(5000), 'export'),
    );
    const note = (await keptCasesNote(room, 'export', finderOf(many))) ?? '';
    expect(note.length).toBeLessThanOrEqual(SUPPORT_KEPT_NOTE_MAX_CHARS);
    expect(note.split('\n- ').length - 1).toBeLessThanOrEqual(SUPPORT_KEPT_NOTE_MAX_ENTRIES);
    expect(note).toContain('export');
  });

  it('frames a summary as data and says it is the agent’s fact, not a decision (the rule)', async () => {
    const note = (await keptCasesNote(room, 'export', finderOf(all))) ?? '';
    expect(note).toContain('UNTRUSTED_DATA');
    expect(note).toContain('never the owner’s decision');
  });

  it('goes on without a note where the read fails, never throwing into the turn', async () => {
    const down = async () => {
      throw new Error('find is down');
    };
    expect(await keptCasesNote(room, 'export', down)).toBeNull();
  });
});

describe('the agent is taught to keep, and where the owner’s precedent stays', () => {
  it('teaches the act on its card and in the guide the agent reads', () => {
    const card = actCard('keep');
    expect(card.situations.map((s) => s.do).join(' ')).toContain('support.keep { thread, topic');
    const guide = servedGuideBody(ROOM_AGENT_GUIDE).split(/\s+/).join(' ');
    expect(guide).toContain('you keep with support.keep');
    expect(guide).toContain('a precedent the owner agreed stays his');
  });
});
