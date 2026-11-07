/**
 * A listed share is named by what it froze (ISS-1072 round 3): Project settings › People listed an
 * answer frozen with no question and no titled block by its "Chat answer" tag alone, no name.
 *
 * @direct-test-of packages/core/src/shares/service.ts
 */
import { describe, expect, it } from 'vitest';
import { titleOf } from './service.js';

describe("a share's name", () => {
  it('is its own title, a release version, then its first titled block', () => {
    expect(titleOf({ title: 'How many issues shipped?', blocks: [{ title: 'Shipped' }] })).toBe(
      'How many issues shipped?',
    );
    expect(titleOf({ header: { version: '0.4.0-dev.268' } })).toBe('Release 0.4.0-dev.268');
    expect(titleOf({ blocks: [{ kind: 'table' }, { title: 'Open by module' }] })).toBe(
      'Open by module',
    );
  });

  it("is the first line of an untitled answer's reply, its Markdown marks dropped", () => {
    expect(
      titleOf({
        blocks: [{ kind: 'kpi' }],
        reply: '\n## **Seven** issues landed today\n\nDetail…',
      }),
    ).toBe('Seven issues landed today');
  });

  it("is a block's finding where the answer froze no reply", () => {
    expect(
      titleOf({
        blocks: [
          { kind: 'chart' },
          { kind: 'table', finding: 'Build waits doubled since Tuesday' },
        ],
      }),
    ).toBe('Build waits doubled since Tuesday');
  });

  it('is cut at a word past eighty characters, and none where the snapshot says nothing', () => {
    const long = `${'word '.repeat(30)}end`;
    const name = titleOf({ reply: long }) ?? '';
    expect(name.endsWith('…')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(81);
    expect(name).not.toMatch(/ …$/);
    expect(titleOf({ blocks: [{ kind: 'kpi' }] })).toBeNull();
    expect(titleOf({ reply: '   ', blocks: [] })).toBeNull();
    expect(titleOf(null)).toBeNull();
  });
});
