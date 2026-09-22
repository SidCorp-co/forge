/**
 * The comment door: a body that opened a record fence and carries no record is
 * told so, whatever the caller declared.
 */

import { describe, expect, it } from 'vitest';
import { MessageRefusedError } from '../messaging/contract.js';
import { commentBodyField } from './body-input.js';
import { screenRecordFence } from './screen.js';

const FENCE = '```';

const refusalFrom = (body: string, declaresRecordRoute: boolean): MessageRefusedError => {
  try {
    screenRecordFence(body, declaresRecordRoute);
  } catch (err) {
    if (err instanceof MessageRefusedError) return err;
    throw err;
  }
  throw new Error('the door said nothing');
};

const unreadableInfo = [`${FENCE}forge-record verdict`, 'criterion: 13', FENCE].join('\n');
const neverClosed = [`${FENCE}forge-record`, 'criterion: 13', 'verdict: skipped'].join('\n');
const twoTags = [
  `${FENCE}forge-record: verdict · contract 1`,
  'criterion: 13',
  FENCE,
  '',
  '`forge-record: review · contract 1`',
].join('\n');

describe('a fence that carries no record', () => {
  it('is refused under its own rule name', () => {
    const refused = refusalFrom(unreadableInfo, false);
    expect(refused.refusals.map((r) => r.rule)).toContain('record-fence-shape');
  });

  it('is refused whether or not the caller declared a record route', () => {
    for (const declared of [true, false]) {
      const refused = refusalFrom(unreadableInfo, declared);
      expect(refused.refusals.map((r) => r.rule)).toContain('record-fence-shape');
    }
  });

  it('refuses a fence that is never closed rather than reading to the end of the body', () => {
    const refused = refusalFrom(neverClosed, false);
    expect(refused.refusals.map((r) => r.rule)).toContain('record-fence-shape');
  });

  it('refuses two tags naming different kinds rather than choosing one', () => {
    const refused = refusalFrom(twoTags, false);
    expect(refused.refusals.map((r) => r.rule)).toContain('record-fence-shape');
  });

  it('shows the shapes that are read and quotes the line it read', () => {
    const refusal = refusalFrom(unreadableInfo, false).refusals.find(
      (r) => r.rule === 'record-fence-shape',
    );
    expect(refusal?.shape).toContain('forge-record');
    expect(refusal?.example).toContain('forge-record');
    expect(refusal?.quote).toBe(`${FENCE}forge-record verdict`);
  });
});

describe('a body the door has nothing to say about', () => {
  it('passes prose through with no warning', () => {
    expect(screenRecordFence('Just a sentence somebody wrote.', false)).toEqual([]);
  });

  it('passes a fence quoted inside another fence through as prose', () => {
    const quoted = ['````', `${FENCE}forge-record`, 'criterion: 13', FENCE, '````'].join('\n');
    expect(screenRecordFence(quoted, false)).toEqual([]);
  });
});

/** The body as the route hands it to the door, which is what the door actually judges. */
const asDelivered = (body: string): string => commentBodyField.parse(body);

const blockAt = (indent: string): string =>
  [`${indent}${FENCE}forge-record`, `${indent}criterion: 6`, `${indent}${FENCE}`].join('\n');

describe('a fence the author indented', () => {
  it('stays prose when the indented block is the first thing in the body', () => {
    for (const indent of [' ', '  ', '   ', '    ']) {
      expect(screenRecordFence(asDelivered(blockAt(indent)), false)).toEqual([]);
    }
  });

  it('stays prose for a client that declared it writes records elsewhere', () => {
    for (const indent of [' ', '  ', '   ', '    ']) {
      expect(screenRecordFence(asDelivered(blockAt(indent)), true)).toEqual([]);
    }
  });

  it('stays prose when the same block carries a kind on its opening fence', () => {
    const body = [
      `    ${FENCE}forge-record: verdict · contract 1`,
      '    criterion: 13',
      '    verdict: skipped',
      `    ${FENCE}`,
    ].join('\n');
    expect(screenRecordFence(asDelivered(body), false)).toEqual([]);
  });

  it('stays prose when prose stands in front of it', () => {
    const body = ['Like this:', '', blockAt('    ')].join('\n');
    expect(screenRecordFence(asDelivered(body), false)).toEqual([]);
  });

  it('stays prose on a blockquote line', () => {
    const body = [`> ${FENCE}forge-record`, '> criterion: 6', `> ${FENCE}`].join('\n');
    expect(screenRecordFence(asDelivered(body), false)).toEqual([]);
  });
});

describe('a record fence at the left margin', () => {
  it('is still read when the body opens with blank lines', () => {
    const body = ['', '', `${FENCE}forge-record: verdict · contract 1`, 'criterion: 6', FENCE].join(
      '\n',
    );
    expect(screenRecordFence(asDelivered(body), false)).toHaveLength(1);
  });

  it('is still refused when it is never closed', () => {
    const body = ['', `${FENCE}forge-record`, 'criterion: 6'].join('\n');
    expect(refusalFrom(asDelivered(body), false).refusals.map((r) => r.rule)).toContain(
      'record-fence-shape',
    );
  });
});
