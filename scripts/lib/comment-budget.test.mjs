import { describe, expect, it } from 'vitest';
import { COMMENT_RULES, silentRules, tally } from './comment-budget.mjs';

const relative = (file) => file.replace('/repo/', '');

const result = (filePath, messages) => ({ filePath, messages });
const finding = (ruleId, severity = 2) => ({ ruleId, severity });

describe('tally', () => {
  it('counts one entry per file per rule', () => {
    const measured = tally(
      [
        result('/repo/a.ts', [
          finding('code-quality/comment-density'),
          finding('code-quality/no-duplicate-comment'),
          finding('code-quality/no-duplicate-comment'),
        ]),
      ],
      relative,
    );
    expect(measured).toEqual({
      'a.ts': {
        'code-quality/comment-density': 1,
        'code-quality/no-duplicate-comment': 2,
      },
    });
  });

  it('leaves out every rule the comment axis does not own', () => {
    const measured = tally(
      [
        result('/repo/a.ts', [
          finding('code-quality/no-raw-elements'),
          finding('code-quality/no-pass-through-wrapper'),
          finding('max-lines'),
        ]),
      ],
      relative,
    );
    expect(measured).toEqual({});
  });

  it('leaves out a warning, because only an error blocks', () => {
    const measured = tally(
      [result('/repo/a.ts', [finding('code-quality/comment-density', 1)])],
      relative,
    );
    expect(measured).toEqual({});
  });

  it('tolerates a result ESLint gave no messages array', () => {
    expect(tally([{ filePath: '/repo/a.ts' }], relative)).toEqual({});
  });

  it('keeps the two files apart when one rule fires in both', () => {
    const measured = tally(
      [
        result('/repo/a.ts', [finding('code-quality/no-historical-narration')]),
        result('/repo/b.ts', [finding('code-quality/no-historical-narration')]),
      ],
      relative,
    );
    expect(measured).toEqual({
      'a.ts': { 'code-quality/no-historical-narration': 1 },
      'b.ts': { 'code-quality/no-historical-narration': 1 },
    });
  });
});

describe('silentRules', () => {
  const on = Object.fromEntries(COMMENT_RULES.map((id) => [id, 'error']));

  it('names nothing when every owned rule is on', () => {
    expect(silentRules({ rules: on })).toEqual([]);
  });

  it('names a rule switched off by severity string', () => {
    expect(silentRules({ rules: { ...on, 'code-quality/comment-density': 'off' } })).toEqual([
      'code-quality/comment-density',
    ]);
  });

  it('names a rule switched off by severity number', () => {
    expect(silentRules({ rules: { ...on, 'code-quality/no-duplicate-comment': [0, {}] } })).toEqual(
      ['code-quality/no-duplicate-comment'],
    );
  });

  it('names a rule the config never mentions', () => {
    const { 'code-quality/no-historical-narration': _absent, ...rest } = on;
    expect(silentRules({ rules: rest })).toEqual(['code-quality/no-historical-narration']);
  });

  it('names all four when the config carries no rules at all', () => {
    expect(silentRules({})).toEqual(COMMENT_RULES);
  });

  it('reads a tuned rule as on, since options do not silence it', () => {
    expect(
      silentRules({ rules: { ...on, 'code-quality/comment-density': ['error', {}] } }),
    ).toEqual([]);
  });
});
