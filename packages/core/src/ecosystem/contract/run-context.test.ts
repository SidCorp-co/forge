import { describe, expect, it } from 'vitest';
import {
  type ContextLink,
  type ContextVersion,
  contractContext,
  pathsNamedIn,
  renderContractContext,
} from './run-context.js';

const ISSUES: ContextLink = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'p-forge',
  contractSlug: 'forge-api',
  pinnedVersion: '2026-09-01',
  callSites: [
    { path: 'cli/src/commands/issue.ts', line: 42, operation: 'GET /api/issues/{id}' },
    { path: 'cli/src/commands/phase.ts', line: 17, operation: 'POST /api/issues/{id}/phase' },
  ],
  notes: ['send the lease token on every phase call'],
};
const OTHER: ContextLink = {
  id: '22222222-2222-4222-8222-222222222222',
  provider: 'p-forge',
  contractSlug: 'forge-mcp',
  pinnedVersion: '2026-09-10',
  callSites: [{ path: 'hooks/session.ts', line: 3, operation: 'forge_issues' }],
  notes: ['mcp guide'],
};

const change = (element: string, text: string) => ({
  element,
  kind: 'removed' as const,
  level: 'breaking' as const,
  text,
});
const VERSIONS: ContextVersion[] = [
  { version: '2026-10-01', changes: [change('GET /api/issues/{id}', 'removed `status`')] },
  { version: '2026-09-15', changes: [change('POST /api/issues/{id}/phase', 'renamed `why`')] },
  { version: '2026-09-01', changes: [change('document', 'pinned version, not moved through')] },
  { version: '2026-08-01', changes: [change('document', 'older than the pin')] },
];

const load = (paths: string[], links = [ISSUES, OTHER], versions = VERSIONS) =>
  contractContext({
    paths,
    links,
    versionsOf: () => versions,
    versioningOf: () => 'dated',
  });

describe('a run is given the contracts its paths call, and nothing else', () => {
  it('a path outside every call site loads nothing', () => {
    expect(load(['web/src/page.tsx', 'cli/src/commands/issues.ts', 'cli/src/commands/is'])).toEqual(
      [],
    );
    expect(renderContractContext(load(['web/src/page.tsx']))).toBeNull();
  });

  it("a path under a call site loads exactly that link's guide and its pinned→latest diff", () => {
    const loaded = load(['cli/src/']);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      link: ISSUES.id,
      paths: ['cli/src'],
      from: '2026-09-01',
      to: '2026-10-01',
      diffNote: 'measured',
      guide: ['send the lease token on every phase call'],
    });
    expect(loaded[0]?.diff.map((c) => [c.version, c.text])).toEqual([
      ['2026-09-15', 'renamed `why`'],
      ['2026-10-01', 'removed `status`'],
    ]);
    const text = renderContractContext(loaded) ?? '';
    expect(text).toContain('2026-09-01 → 2026-10-01');
    expect(text).not.toContain('mcp guide');
    expect(text).not.toContain('older than the pin');
  });

  it('a file path matches only the call sites in that file', () => {
    const [one] = load(['cli/src/commands/phase.ts']);
    expect(one?.callSites.map((s) => s.line)).toEqual([17]);
  });

  it('a consumer already on the latest version loads the guide with an empty diff, and says so', () => {
    const onLatest = { ...ISSUES, pinnedVersion: '2026-10-01' };
    const [one] = load(['cli/src/commands/issue.ts'], [onLatest]);
    expect(one).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-01',
      diffNote: 'already-on-latest',
      diff: [],
      guide: onLatest.notes,
    });
    expect(renderContractContext(one ? [one] : [])).toMatch(
      /Diff: none — the consumer is already on the latest version/,
    );
  });

  it('a contract with no recorded version loads the guide and says there is no diff', () => {
    const [one] = load(['hooks'], [OTHER], []);
    expect(one).toMatchObject({ to: null, diffNote: 'no-version-recorded', diff: [] });
  });
});

describe('the paths an issue names', () => {
  it('reads repository paths out of prose and code spans, not URLs or words', () => {
    expect(
      pathsNamedIn(
        'Fix `cli/src/commands/issue.ts` and hooks/session.ts; see https://x.io/a/b. and/or',
      ),
    ).toEqual(['cli/src/commands/issue.ts', 'hooks/session.ts', 'and/or']);
  });
});
