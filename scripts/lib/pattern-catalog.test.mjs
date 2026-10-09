import { describe, expect, it } from 'vitest';
import { judgeCatalog, renderCatalog } from './pattern-catalog.mjs';

const DIR = 'docs/patterns';
const GEN = 'packages/contracts/src/pattern-catalog.ts';
const TRACKED = new Set([
  'packages/core/src/suggestions/routes.ts',
  'packages/core/src/suggestions/rules.test.ts',
  'packages/web-v2/src/features/suggestions/hooks.ts',
]);

const page = ({
  kind = 'API route',
  reference = '- `packages/core/src/suggestions/routes.ts` — the route file',
  tests = '- `packages/core/src/suggestions/rules.test.ts` — the guards, one case each',
  checklist = '1. The route holds no query.\n2. A bad body is refused at its pointer.',
} = {}) =>
  [
    '# API route',
    '',
    `**Change kind:** ${kind}`,
    '**Introduced by:** ISS-466',
    '',
    'A REST route over one service.',
    '',
    reference === null ? '' : `## Reference\n\n${reference}\n`,
    tests === null ? '' : `## Test shape\n\n${tests}\n\nA new route's rules get a case each.\n`,
    checklist === null ? '' : `## Review checklist\n\n${checklist}\n`,
  ].join('\n');

const INDEX = '# Patterns\n\n| [API route](api-route.md) | API route |\n';

/** The catalog of one page, judged; `generated` defaults to exactly what the pages produce. */
function judge(raw, { index = INDEX, kinds = ['API route'], generated } = {}) {
  const pages = { [`${DIR}/api-route.md`]: raw };
  const first = judgeCatalog({
    dir: DIR,
    pages,
    index,
    tracked: TRACKED,
    kinds,
    generated: '',
    generatedRel: GEN,
  });
  return judgeCatalog({
    dir: DIR,
    pages,
    index,
    tracked: TRACKED,
    kinds,
    generated: generated === undefined ? first.expected : generated,
    generatedRel: GEN,
  });
}

const rules = (verdict) => verdict.violations.map((v) => v.split(': ')[1]);

describe('a catalog entry names a reference, a test shape and a checklist that exist', () => {
  it('a page with all three, indexed, with its catalog generated, holds', () => {
    const verdict = judge(page());
    expect(verdict).toMatchObject({ code: 0, scanned: 1, violations: [] });
    expect(verdict.entries[0]).toEqual({
      slug: 'api-route',
      title: 'API route',
      changeKind: 'API route',
      page: `${DIR}/api-route.md`,
      introducedBy: 'ISS-466',
      reference: ['packages/core/src/suggestions/routes.ts'],
      tests: ['packages/core/src/suggestions/rules.test.ts'],
      checklist: ['The route holds no query.', 'A bad body is refused at its pointer.'],
    });
  });

  it('a page with no reference section is refused by name', () => {
    expect(rules(judge(page({ reference: null })))).toEqual(['PATTERN_REFERENCE_MISSING']);
  });

  it('a reference that no tracked file carries is refused, naming the path', () => {
    const verdict = judge(page({ reference: '- `packages/core/src/suggestions/route.ts` — typo' }));
    expect(rules(verdict)).toEqual(['PATTERN_REFERENCE_NOT_FOUND']);
    expect(verdict.violations[0]).toContain('packages/core/src/suggestions/route.ts');
  });

  it('a directory reference holds while it holds a tracked file, and is refused when it holds none', () => {
    expect(
      judge(page({ reference: '- `packages/web-v2/src/features/suggestions/` — the feature' }))
        .code,
    ).toBe(0);
    expect(
      rules(judge(page({ reference: '- `packages/web-v2/src/features/gone/` — moved' }))),
    ).toEqual(['PATTERN_REFERENCE_NOT_FOUND']);
  });

  it('a page with no test shape, or one naming no test file, is refused', () => {
    expect(rules(judge(page({ tests: null })))).toEqual(['PATTERN_TEST_SHAPE_MISSING']);
    expect(
      rules(judge(page({ tests: '- `packages/core/src/suggestions/routes.ts` — not a test' }))),
    ).toEqual(['PATTERN_TEST_SHAPE_MISSING']);
  });

  it('a reference test that does not exist is refused by name', () => {
    expect(
      rules(judge(page({ tests: '- `packages/core/src/suggestions/routes.test.ts` — gone' }))),
    ).toEqual(['PATTERN_TEST_NOT_FOUND']);
  });

  it('a checklist with no numbered line, or no checklist, is refused', () => {
    expect(rules(judge(page({ checklist: null })))).toEqual(['PATTERN_CHECKLIST_MISSING']);
    expect(rules(judge(page({ checklist: '- a bullet is not a checklist line' })))).toEqual([
      'PATTERN_CHECKLIST_MISSING',
    ]);
  });

  it('a page with no introducing issue is refused, so a new entry is traceable to its approval', () => {
    const raw = page().replace('**Introduced by:** ISS-466\n', '');
    expect(rules(judge(raw))).toEqual(['PATTERN_HEADER_MISSING']);
  });

  it('a package name or an extension-less token is not read as a reference', () => {
    const raw = page({
      reference:
        '- `packages/core/src/suggestions/routes.ts` — the route, its types from `@forge/contracts` and `packages/runner`',
    });
    expect(judge(raw).code).toBe(0);
  });

  it('a path inside a fenced block is not read as a reference', () => {
    const fenced = '```text\n`packages/core/src/suggestions/routes.ts`\n```';
    expect(rules(judge(page({ reference: fenced })))).toEqual(['PATTERN_REFERENCE_MISSING']);
  });
});

describe('the catalog as a whole', () => {
  it('a page the index does not link, and an index link to no page, are each refused', () => {
    expect(rules(judge(page(), { index: '# Patterns\n' }))).toEqual(['PATTERN_NOT_INDEXED']);
    expect(rules(judge(page(), { index: `${INDEX}| [Screen](screen.md) | Screen |\n` }))).toEqual([
      'PATTERN_INDEX_DANGLING',
    ]);
  });

  it('a declared change kind no page covers is refused', () => {
    expect(rules(judge(page(), { kinds: ['API route', 'Migration'] }))).toEqual([
      'PATTERN_KIND_UNCOVERED',
    ]);
  });

  it('a generated catalog that disagrees with the pages, or is absent, is refused as stale', () => {
    expect(rules(judge(page(), { generated: null }))).toEqual(['PATTERN_CATALOG_STALE']);
    const stale = renderCatalog([], DIR);
    expect(rules(judge(page(), { generated: stale }))).toEqual(['PATTERN_CATALOG_STALE']);
  });

  it('no page at all cannot be judged, which is exit 2 and never a pass', () => {
    const verdict = judgeCatalog({
      dir: DIR,
      pages: {},
      index: INDEX,
      tracked: TRACKED,
      kinds: [],
      generated: null,
      generatedRel: GEN,
    });
    expect(verdict.code).toBe(2);
  });
});
