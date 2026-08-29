import { describe, expect, it } from 'vitest';
import { judge, judgeDocument } from './honest-costs.mjs';

const PRICED = `# A proposal

## Honest costs

| Choice | What it costs you |
|---|---|
| one instance per team | you operate and upgrade it yourself, and no shared plane absorbs your outage |
`;

describe('judgeDocument', () => {
  it('passes a section that prices a choice in a table', () => {
    expect(judgeDocument('docs/proposals/a.md', PRICED)).toEqual([]);
  });

  it('passes a numbered heading, which is how VISION writes its sections', () => {
    const numbered = PRICED.replace('## Honest costs', '## 6. Honest costs');
    expect(judgeDocument('docs/VISION.md', numbered)).toEqual([]);
  });

  it('names the document when the section is absent', () => {
    const reasons = judgeDocument(
      'docs/proposals/a.md',
      '# A proposal\n\n## Boundaries\n\n- not a tracker\n',
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('docs/proposals/a.md');
    expect(reasons[0]).toContain('no `## Honest costs` section');
  });

  it('refuses a section that is present and says nothing', () => {
    const thin = '# A proposal\n\n## Honest costs\n\n- some\n';
    expect(judgeDocument('a.md', thin).join(' ')).toContain('prices nothing');
  });

  it('refuses a placeholder where the price should be', () => {
    const placeheld =
      '# A proposal\n\n## Honest costs\n\n- TBD\n- the rest of a sentence that carries more than the floor of words\n';
    expect(judgeDocument('a.md', placeheld).join(' ')).toContain('TBD');
  });

  it('refuses prose with no priced row', () => {
    const prose =
      '# A proposal\n\n## Honest costs\n\nAdopting this takes rather a lot from you in ways that are hard to enumerate briefly.\n';
    expect(judgeDocument('a.md', prose).join(' ')).toContain('prose');
  });

  it('reads only its own section, not the one after it', () => {
    const trailing = `${PRICED}\n## Next section\n\n- TBD\n`;
    expect(judgeDocument('a.md', trailing)).toEqual([]);
  });

  it('keeps reading past a deeper heading nested inside the section', () => {
    const nested =
      '# A proposal\n\n## Honest costs\n\n### For the operator\n\n- you pay for every model account, and there is no sign-in-and-go path\n';
    expect(judgeDocument('a.md', nested)).toEqual([]);
  });

  it('does not read `N/A for self-hosted` as a placeholder', () => {
    const qualified = PRICED.replace(
      'you operate and upgrade it yourself, and no shared plane absorbs your outage',
      'N/A for self-hosted, and you carry the upgrade yourself every release',
    );
    expect(judgeDocument('a.md', qualified)).toEqual([]);
  });
});

describe('judge', () => {
  it('reports every failing document, not just the first', () => {
    const verdict = judge({ 'a.md': '# a\n', 'b.md': '# b\n', 'c.md': PRICED });
    expect(verdict.code).toBe(1);
    expect(verdict.violations).toHaveLength(2);
    expect(verdict.scanned).toBe(3);
  });

  it('is exit 2 on an empty scope, never a pass', () => {
    expect(judge({})).toEqual({
      code: 2,
      reason: 'no documents in scope — the rule would hold over nothing',
    });
  });

  it('is exit 2 when a document could not be read', () => {
    const verdict = judge({ 'a.md': PRICED, 'gone.md': null });
    expect(verdict.code).toBe(2);
    expect(verdict.reason).toContain('gone.md');
  });

  it('counts the documents it scanned when everything passes', () => {
    expect(judge({ 'a.md': PRICED, 'b.md': PRICED })).toEqual({ code: 0, scanned: 2 });
  });
});
