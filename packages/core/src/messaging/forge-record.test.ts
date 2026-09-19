/**
 * The parse, read against the shapes the writer actually emits.
 *
 * Every body below is the layout `forge record` writes — a heading, the fenced
 * block, a blank line, then the tag naming the kind — rather than a shape
 * invented here, because a parse that agrees with a fixture nobody writes
 * proves nothing about the comments this door screens (ISS-1089).
 */

import { describe, expect, it } from 'vitest';
import {
  FORGE_RECORD_FIELD_BUDGET,
  overBudget,
  parseForgeRecord,
  REQUESTED_FIELDS,
} from './forge-record.js';

const fence = '```';

const record = (body: string, kind = 'confirmation'): string =>
  `## Confirmation\n\n${fence}forge-record\n${body}\n${fence}\n\n\`forge-record: ${kind} · contract 1\``;

describe('what a body yields', () => {
  it('yields a record for a body carrying a fence', () => {
    const parsed = parseForgeRecord(record('finding: holds'));
    expect(parsed?.fields).toEqual([{ key: 'finding', value: 'holds', over: 0 }]);
  });

  it('yields nothing for a body carrying no fence', () => {
    expect(parseForgeRecord('## Just a comment\n\nMerged and deployed.')).toBeNull();
  });

  it('yields nothing for a body that is empty', () => {
    expect(parseForgeRecord('')).toBeNull();
  });

  it('yields nothing for a fenced block that is not a record', () => {
    expect(parseForgeRecord('```ts\nconst a = 1;\n```')).toBeNull();
  });
});

describe('the kind, which the tag line names and the fence does not', () => {
  it('names the kind its tag line names', () => {
    expect(parseForgeRecord(record('finding: holds', 'verdict'))?.kind).toBe('verdict');
  });

  it('reads the contract number beside it', () => {
    expect(parseForgeRecord(record('finding: holds'))?.contract).toBe(1);
  });

  it('takes the tag that ends the block, not one quoted inside a field', () => {
    const body = [
      '## Confirmation',
      '',
      `${fence}forge-record`,
      'detail: the comment I am quoting ended with',
      '  forge-record: verdict · contract 9',
      'finding: holds',
      fence,
      '',
      '`forge-record: confirmation · contract 1`',
    ].join('\n');
    const parsed = parseForgeRecord(body);
    expect({ kind: parsed?.kind, contract: parsed?.contract }).toEqual({
      kind: 'confirmation',
      contract: 1,
    });
    expect(parsed?.fields[0]?.value).toBe(
      'the comment I am quoting ended with\nforge-record: verdict · contract 9',
    );
  });

  it('names no kind where a quoted tag is the only one in the body', () => {
    const body = [
      `${fence}forge-record`,
      'detail: it ended with',
      '  forge-record: verdict · contract 9',
      fence,
    ].join('\n');
    expect(parseForgeRecord(body)?.kind).toBeNull();
  });

  it('names no kind where the fence carries no tag, rather than refusing to read it', () => {
    const parsed = parseForgeRecord(`${fence}forge-record\nfinding: holds\n${fence}`);
    expect({ kind: parsed?.kind, contract: parsed?.contract, fields: parsed?.fields }).toEqual({
      kind: null,
      contract: null,
      fields: [{ key: 'finding', value: 'holds', over: 0 }],
    });
  });
});

describe('the grammar, which is the writer’s and not this file’s', () => {
  it('reads a two-space indented line as the value above continuing, newline and all', () => {
    const parsed = parseForgeRecord(record('why: first line\n  second line\nfinding: holds'));
    expect(parsed?.fields).toEqual([
      { key: 'why', value: 'first line\nsecond line', over: 0 },
      { key: 'finding', value: 'holds', over: 0 },
    ]);
  });

  it('strips the two spaces off a continuation that itself reads like a key', () => {
    const parsed = parseForgeRecord(record('why: first line\n  second: not a key'));
    expect(parsed?.fields).toEqual([
      { key: 'why', value: 'first line\nsecond: not a key', over: 0 },
    ]);
  });

  it('reads a key repeated in one fence as two fields rather than as an overwrite', () => {
    const parsed = parseForgeRecord(record('decision: first\ndecision: second'));
    expect(parsed?.fields.map((f) => f.value)).toEqual(['first', 'second']);
  });

  it('keeps the fields in the order they were written', () => {
    const parsed = parseForgeRecord(record('where: a\nis: b\nfinding: holds'));
    expect(parsed?.fields.map((f) => f.key)).toEqual(['where', 'is', 'finding']);
  });

  it('closes on a longer fence than three backticks where the writer opened one', () => {
    const body = `\`\`\`\`forge-record\nwhy: holds \`\`\`inline\`\`\`\n\`\`\`\``;
    expect(parseForgeRecord(body)?.fields).toEqual([
      { key: 'why', value: 'holds ```inline```', over: 0 },
    ]);
  });

  it('reads an unterminated fence rather than dropping the record', () => {
    const parsed = parseForgeRecord(`${fence}forge-record\nfinding: holds`);
    expect(parsed?.fields).toEqual([{ key: 'finding', value: 'holds', over: 0 }]);
  });
});

describe('the fields ISS-1089 asks for and contract 1 does not carry', () => {
  it('reports `lead` absent, and puts nothing in its place', () => {
    const parsed = parseForgeRecord(
      record('detail: A sentence that would make a fine lead. Then more.'),
    );
    expect({ lead: parsed?.lead, absent: parsed?.absent }).toEqual({
      lead: null,
      absent: ['lead', 'beside'],
    });
  });

  it('reports `beside` absent on a record that does carry a lead', () => {
    const parsed = parseForgeRecord(record('lead: The screen admits a wall.\nfinding: holds'));
    expect({ lead: parsed?.lead, absent: parsed?.absent }).toEqual({
      lead: 'The screen admits a wall.',
      absent: ['beside'],
    });
  });

  it('reports neither absent where the record carries both', () => {
    const parsed = parseForgeRecord(
      record('lead: One sentence.\nbeside: Another issue’s finding.'),
    );
    expect(parsed?.absent).toEqual([]);
  });

  it('asks for exactly the two fields the issue names', () => {
    expect([...REQUESTED_FIELDS]).toEqual(['lead', 'beside']);
  });
});

describe('the budget, counted in code points', () => {
  it('counts a field of exactly the budget as within it', () => {
    expect(overBudget('x'.repeat(FORGE_RECORD_FIELD_BUDGET))).toBe(0);
  });

  it('counts one code point past the budget as one over', () => {
    expect(overBudget('x'.repeat(FORGE_RECORD_FIELD_BUDGET + 1))).toBe(1);
  });

  it('counts an astral character once, as a reader counts it', () => {
    expect(overBudget('🙂'.repeat(FORGE_RECORD_FIELD_BUDGET))).toBe(0);
  });

  it('carries the overage on the field itself', () => {
    const long = 'x'.repeat(FORGE_RECORD_FIELD_BUDGET + 57);
    expect(parseForgeRecord(record(`why: ${long}`))?.fields[0]?.over).toBe(57);
  });
});

describe('where the block sits, so a reader can draw the prose around it', () => {
  const body = record('finding: holds');

  it('starts the block at the opening fence', () => {
    const parsed = parseForgeRecord(body);
    expect(body.slice(parsed?.at ?? 0).startsWith(`${fence}forge-record`)).toBe(true);
  });

  it('ends the block past the tag line, so nothing of the record is left drawn as prose', () => {
    const parsed = parseForgeRecord(body);
    expect(body.slice(parsed?.to ?? 0).trim()).toBe('');
    expect(body.slice(parsed?.at ?? 0, parsed?.to ?? 0)).toContain('forge-record: confirmation');
  });

  it('leaves the prose before the fence outside the block', () => {
    const parsed = parseForgeRecord(body);
    expect(body.slice(0, parsed?.at ?? 0)).toBe('## Confirmation\n\n');
  });

  it('leaves prose written after the record outside the block', () => {
    const after = `${body}\n\nAnd a sentence the writer added below.`;
    const parsed = parseForgeRecord(after);
    expect(after.slice(parsed?.to ?? 0)).toBe('\n\nAnd a sentence the writer added below.');
  });
});
