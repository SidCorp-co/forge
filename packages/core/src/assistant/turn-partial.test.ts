// The message a turn posts at 90 s is read by the whole room, so it says what the turn read in plain
// words and never quotes a call. REQ-32, lane A8d: on dev.185 its read list was a dump of
// `forge_show {"block":{"kind":"table",…}}` lines — the tool calls' JSON, run ids and a narrative
// draft, in the room.

import { describe, expect, it } from 'vitest';
import type { ChatToolset } from './tools/mcp-adapter.js';
import { partialReplyText } from './turn-partial.js';
import type { DoneCall } from './turn-writes.js';
import { turnWrites } from './turn-writes.js';

const call = (name: string, args: unknown, extra: Partial<DoneCall> = {}): DoneCall => {
  const argsJson = JSON.stringify(args);
  return {
    name,
    arguments: argsJson,
    said: `${name} ${argsJson}`,
    result: '{"rows":[{"key":"REQ-1"}]}',
    write: false,
    keys: [],
    ...extra,
  };
};

const show = (kind: string) =>
  call('forge_show', {
    block: {
      kind,
      columns: ['key', 'title'],
      source: { runId: '574c9df4-03eb-43a4-a7b8-4bd20ba70cb2' },
    },
  });
const template = (templateId: string) =>
  call('forge_template', {
    templateId,
    params: {},
    runIds: ['393011b9-cbb8-4efd-9271-dfb9f4ad83ca'],
    narrative: { summary: 'Báo cáo release-readiness không trả về release nào' }, // i18n-allow: the dev.185 draft under test
  });

/** The ten calls the dev.185 turn had made when its partial went out. */
const DEV_185: DoneCall[] = [
  call('forge_project_status', { days: 7 }),
  template('progress'),
  template('release'),
  template('roadmap'),
  show('table'),
  show('table'),
  show('table'),
  template('progress'),
  template('release'),
  template('roadmap'),
];

const text = (calls: readonly DoneCall[], language: 'en' | 'vi') =>
  partialReplyText({ calls, language, handleName: 'forge', waitedMs: 90_400 });

describe('the partial a turn posts at its first ceiling', () => {
  it('holds no JSON, no argument and no result: only what it read, in plain words', () => {
    for (const language of ['en', 'vi'] as const) {
      const said = text(DEV_185, language);
      expect(said).not.toMatch(/[{}[\]"]/);
      expect(said).not.toContain('forge_');
      expect(said).not.toContain('runId');
      expect(said).not.toContain('574c9df4');
      expect(said).not.toContain('release-readiness');
      expect(said).not.toContain('REQ-1');
    }
  });

  it('counts what it read by tool, in the order it first did each, in the asker language', () => {
    expect(text(DEV_185, 'en')).toContain(
      'Read so far: read the project status, ran 6 reports, drew 3 tables.',
    );
    expect(text(DEV_185, 'vi')).toContain(
      'Đã đọc: đọc tình trạng dự án, chạy 6 báo cáo, vẽ 3 bảng.', // i18n-allow: the Vietnamese partial under test
    );
    expect(text(DEV_185, 'vi')).toContain('đang làm tiếp'); // i18n-allow: the Vietnamese partial under test
  });

  it('names a write by what it did and the keys it returned, never by its call', () => {
    const said = text(
      [
        call('forge_feedback', { title: 'Share loses blocks' }, { write: true, keys: ['FB-61'] }),
        call(
          'forge',
          { argv: ['comment', 'ISS-4', '--body', 'see FB-61'] },
          { write: true, keys: ['ISS-4'] },
        ),
        show('chart'),
        show('table'),
        call('forge_union_probe', { q: 'x' }),
        call('forge_union_probe', { q: 'y' }),
      ],
      'en',
    );
    expect(said).toContain('Done so far:\n- recorded feedback → FB-61\n- commented → ISS-4');
    expect(said).toContain('Read so far: drew 1 chart and 1 table, used union probe twice.');
    expect(said).not.toContain('Share loses blocks');
    expect(said).not.toMatch(/[{}[\]"]/);
  });

  it('says it is still reading when nothing has landed yet', () => {
    expect(text([], 'en')).toContain('Nothing is finished yet; it is still reading the project.');
  });

  // REQ-32 BC-6 r3, dev.193 ISS-430: a turn that only read through `forge issue` was told as "updated an issue".
  describe('a CLI call is told as a write only when it wrote', () => {
    const ran = async (calls: Array<{ name: string; args: unknown }>): Promise<DoneCall[]> => {
      const tools: ChatToolset = {
        tools: [],
        ranAs: () => null,
        async execute() {
          return {
            content: [
              {
                type: 'text' as const,
                text: '{"issues":[{"key":"ISS-17"},{"key":"REQ-17"}]}',
              },
            ],
          };
        },
      };
      const writes = turnWrites(tools);
      for (const c of calls) await writes.tools?.execute(c.name, JSON.stringify(c.args));
      return [...writes.calls()];
    };
    const said = async (argv: string[], extra: Record<string, unknown> = {}) =>
      text(await ran([{ name: 'forge', args: { argv, ...extra } }]), 'en');

    it.each([
      ['one issue shown', ['issue', 'ISS-17']],
      ['a list filtered by status', ['issue', '--status', 'open', '--limit', '5']],
      ['a search', ['issue', '--search', 'share']],
      ['fields asked for', ['issue', 'ISS-17', '--fields', 'status,title', '--full']],
      ['another project read', ['issue', '--project', 'hop', '--status', 'open']],
      ['a thread read with no body', ['comment', 'ISS-17']],
    ])('%s: no write line', async (_name, argv) => {
      const t = await said(argv);
      expect(t).not.toContain('Done so far');
      expect(t).not.toContain('updated an issue');
      expect(t).not.toContain('commented');
      expect(t).toContain('Read so far: looked up the tracker.');
    });

    it.each([
      [
        'a field set',
        ['issue', 'ISS-17', '--set', 'priority=high', '--why', 'x'],
        {},
        'updated an issue',
      ],
      ['an edge', ['issue', 'ISS-17', '--blocks', 'ISS-18'], {}, 'updated an issue'],
      ['an edge removed', ['issue', 'ISS-17', '--unlink', 'ISS-18'], {}, 'updated an issue'],
      ['a comment with a body', ['comment', 'ISS-17', '-'], { body: 'hello' }, 'commented'],
      ['an attachment', ['attach', 'issue', 'ISS-17', 'a.png'], {}, 'attached a file'],
    ])('%s: a write line with its keys', async (_name, argv, extra, line) => {
      expect(await said(argv, extra)).toContain(`Done so far:\n- ${line} → ISS-17, REQ-17`);
    });

    it('a proposal is neither a write nor a lookup: it is told as used', async () => {
      const t = await said(['issue', 'ISS-17', '--propose', '--set', 'priority=high']);
      expect(t).not.toContain('Done so far');
      expect(t).toContain('Read so far: used forge issue.');
    });

    it('a read and a write in one turn name only the write as done', async () => {
      const calls = await ran([
        { name: 'forge', args: { argv: ['issue', 'ISS-17'] } },
        {
          name: 'forge',
          args: { argv: ['issue', 'ISS-17', '--set', 'priority=high'] },
        },
      ]);
      const t = text(calls, 'en');
      expect(t.match(/updated an issue/g)).toHaveLength(1);
    });
  });
});
