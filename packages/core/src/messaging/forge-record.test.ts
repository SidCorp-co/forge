/**
 * The fence grammar: which bodies mean a record, and which of those yield one.
 */

import { describe, expect, it } from 'vitest';
import { parseForgeRecord } from './forge-record.js';

const FENCE = '```';
const OUTER = '````';

const strict = [
  'The run judged criterion 13.',
  '',
  `${FENCE}forge-record`,
  'criterion: 13',
  'verdict: skipped',
  FENCE,
  '',
  '`forge-record: verdict · contract 1`',
].join('\n');

const onTheFence = [
  'The run judged criterion 13.',
  '',
  `${FENCE}forge-record: verdict · contract 1`,
  'criterion: 13',
  'verdict: skipped',
  FENCE,
].join('\n');

const insideAnotherFence = [
  'This is how one is written:',
  '',
  OUTER,
  `${FENCE}forge-record`,
  'criterion: 13',
  'verdict: skipped',
  FENCE,
  OUTER,
].join('\n');

describe('the fence a body means as a record', () => {
  it('reads the tag off the fence itself, where a markdown writer puts it', () => {
    const record = parseForgeRecord(onTheFence);
    expect(record?.kind).toBe('verdict');
    expect(record?.contract).toBe(1);
    expect(record?.fields.map((f) => f.key)).toEqual(['criterion', 'verdict']);
    expect(record?.fields.map((f) => f.value)).toEqual(['13', 'skipped']);
  });

  it('reads the same record off either shape', () => {
    const fromTag = parseForgeRecord(strict);
    const fromFence = parseForgeRecord(onTheFence);
    expect(fromFence?.kind).toBe(fromTag?.kind);
    expect(fromFence?.contract).toBe(fromTag?.contract);
    expect(fromFence?.fields.map((f) => f.key)).toEqual(fromTag?.fields.map((f) => f.key));
  });

  it('keeps the shape the CLI writes parsing exactly as it did', () => {
    const record = parseForgeRecord(strict);
    expect(record?.kind).toBe('verdict');
    expect(record?.contract).toBe(1);
    expect(record?.fields.map((f) => f.key)).toEqual(['criterion', 'verdict']);
  });

  it('leaves a fence quoted inside another fence as prose', () => {
    expect(parseForgeRecord(insideAnotherFence)).toBeNull();
  });

  it('leaves an indented or quoted example as prose', () => {
    const indented = [
      'Like this:',
      '',
      `    ${FENCE}forge-record`,
      '    criterion: 13',
      `    ${FENCE}`,
    ];
    const quoted = [`> ${FENCE}forge-record`, '> criterion: 13', `> ${FENCE}`];
    expect(parseForgeRecord(indented.join('\n'))).toBeNull();
    expect(parseForgeRecord(quoted.join('\n'))).toBeNull();
  });

  it('leaves an example enclosed by a tilde fence as prose, as a backtick one is', () => {
    const body = ['~~~', `${FENCE}forge-record`, 'criterion: 13', FENCE, '~~~'].join('\n');
    expect(parseForgeRecord(body)).toBeNull();
  });

  it('does not let a tilde fence open a record', () => {
    const body = ['~~~forge-record', 'criterion: 13', '~~~'].join('\n');
    expect(parseForgeRecord(body)).toBeNull();
  });

  it('keeps a field holding backticks indented past the close column', () => {
    const body = [`${FENCE}forge-record`, 'criterion: 13', '    ```', 'verdict: pass', FENCE].join(
      '\n',
    );
    expect(parseForgeRecord(body)?.fields.map((f) => f.key)).toEqual(['criterion', 'verdict']);
  });

  it('closes on a fence indented within the three spaces markdown allows', () => {
    const body = [`${FENCE}forge-record`, 'criterion: 13', '  ```', 'verdict: pass'].join('\n');
    expect(parseForgeRecord(body)?.fields.map((f) => f.key)).toEqual(['criterion']);
  });

  it('does not read a longer word that merely opens with the tag', () => {
    const body = [`${FENCE}forge-recording`, 'criterion: 13', FENCE].join('\n');
    expect(parseForgeRecord(body)).toBeNull();
  });

  it('yields no record for a fence it cannot read', () => {
    const unreadable = [`${FENCE}forge-record verdict`, 'criterion: 13', FENCE].join('\n');
    const unclosed = [`${FENCE}forge-record`, 'criterion: 13', 'verdict: skipped'].join('\n');
    expect(parseForgeRecord(unreadable)).toBeNull();
    expect(parseForgeRecord(unclosed)).toBeNull();
  });

  it('says nothing about a body carrying no fence', () => {
    expect(parseForgeRecord('Just a sentence somebody wrote for somebody to read.')).toBeNull();
  });
});
