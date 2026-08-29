import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judge, judgeDocument, listProposals, selectProposals } from './honest-costs.mjs';

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

  it('does not accept a heading that only appears inside a fenced example', () => {
    const illustrated = [
      '# A proposal',
      '',
      '## How to write one',
      '',
      '```md',
      '## Honest costs',
      '',
      '| Choice | What it costs you |',
      '|---|---|',
      '| an example row | that prices an example, and nothing this document chose |',
      '```',
      '',
    ].join('\n');
    expect(judgeDocument('a.md', illustrated).join(' ')).toContain('no `## Honest costs` section');
  });

  it('ignores a fenced block sitting inside a real section', () => {
    const withCode = `${PRICED}\n\`\`\`sh\nTBD\n\`\`\`\n`;
    expect(judgeDocument('a.md', withCode)).toEqual([]);
  });

  it('does not let a nested fence reopen the block and re-admit an example', () => {
    const nested = [
      '# A proposal',
      '',
      '## How to write one',
      '',
      '````md',
      '```',
      '## Honest costs',
      '',
      '| Choice | What it costs you |',
      '|---|---|',
      '| an example row | that prices an example, and nothing this document chose |',
      '```',
      '````',
      '',
    ].join('\n');
    expect(judgeDocument('a.md', nested).join(' ')).toContain('no `## Honest costs` section');
  });

  it('does not accept a heading that is commented out', () => {
    const commented =
      '# A proposal\n\n<!--\n## Honest costs\n\n- a price nobody can read on the page\n-->\n';
    expect(judgeDocument('a.md', commented).join(' ')).toContain('no `## Honest costs` section');
  });

  it('does not accept `##Honest costs`, which renders as a paragraph', () => {
    const unspaced = PRICED.replace('## Honest costs', '##Honest costs');
    expect(judgeDocument('a.md', unspaced).join(' ')).toContain('no `## Honest costs` section');
  });

  it('counts the price, not the table scaffolding, against the floor', () => {
    const scaffolding = [
      '# A proposal',
      '',
      '## Honest costs',
      '',
      '| Choice | What it costs you |',
      '|---|---|',
      '| X | some money for you |',
      '',
    ].join('\n');
    expect(judgeDocument('a.md', scaffolding).join(' ')).toContain('prices nothing');
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

describe('selectProposals', () => {
  it('takes a proposal nested one directory down', () => {
    expect(selectProposals(['a.md', 'rfc-drafts', 'rfc-drafts/sub.md'])).toEqual([
      'a.md',
      'rfc-drafts/sub.md',
    ]);
  });

  it('excludes the index at every depth, not only at the top', () => {
    expect(selectProposals(['README.md', 'nested/README.md', 'nested/real.md'])).toEqual([
      'nested/real.md',
    ]);
  });

  it('leaves the drawn figures and directory entries out', () => {
    expect(selectProposals(['duplex-architecture.html', 'nested', 'a.md'])).toEqual(['a.md']);
  });
});

describe('listProposals', () => {
  it('walks subdirectories on a real tree, and skips an index at any depth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honest-costs-'));
    mkdirSync(join(dir, 'rfc-drafts'));
    for (const rel of [
      'README.md',
      'flat.md',
      'drawn.html',
      'rfc-drafts/README.md',
      'rfc-drafts/sub.md',
    ]) {
      writeFileSync(join(dir, rel), '# x\n');
    }
    expect(listProposals(dir).sort()).toEqual(['flat.md', 'rfc-drafts/sub.md']);
  });
});
