import { describe, expect, it } from 'vitest';
import {
  baselineOf,
  compareBaseline,
  cycleFindings,
  declaredTables,
  directionFindings,
  kindFindings,
  markers,
  moduleOf,
  parseDeclaration,
  publicFaceFindings,
  refusalFindings,
  routeQueryFindings,
  statusWriteFindings,
  tableWriterFindings,
  tableWrites,
  tally,
} from './module-shape.mjs';

const S = 'packages/core/src/';
const MODULES = {
  '(root)': { kind: 'door' },
  mcp: { kind: 'door' },
  runs: { kind: 'read-model' },
  feedback: { kind: 'domain', owns: ['feedback'] },
  suggestions: { kind: 'domain', owns: ['suggestions'] },
  issues: { kind: 'kernel', owns: ['issues'] },
  lifecycle: { kind: 'kernel' },
  integrations: { kind: 'adapter' },
  'integrations/github': { kind: 'adapter' },
  db: { kind: 'platform' },
  lib: { kind: 'platform' },
};
const edge = (from, to) => ({ fromFile: `${S}${from}`, toFile: `${S}${to}` });

describe('parseDeclaration', () => {
  it('refuses an unknown kind by name, listing the valid ones', () => {
    const { faults } = parseDeclaration({ modules: { x: { kind: 'service' } } });
    expect(faults[0]).toContain('x declares kind "service", not one of kernel, domain, read-model');
  });
  it('refuses a table owned by two modules', () => {
    const { faults } = parseDeclaration({
      modules: { a: { kind: 'domain', owns: ['t'] }, b: { kind: 'domain', owns: ['t'] } },
    });
    expect(faults).toEqual([
      'modules.json: table t is owned by both a and b; a table has one writer',
    ]);
  });
  it('refuses a document with no modules object', () => {
    expect(parseDeclaration({}).faults[0]).toContain('no `modules` object');
  });
  it('maps each owned table to its module', () => {
    expect(parseDeclaration({ modules: MODULES }).owners.get('suggestions')).toBe('suggestions');
  });
});

describe('moduleOf', () => {
  it('puts a file directly under src in the root module', () => {
    expect(moduleOf(`${S}index.ts`, MODULES)).toBe('(root)');
  });
  it('takes the longest declared path', () => {
    expect(moduleOf(`${S}integrations/github/client.ts`, MODULES)).toBe('integrations/github');
    expect(moduleOf(`${S}integrations/registry.ts`, MODULES)).toBe('integrations');
  });
  it('falls back to the top directory when nothing is declared', () => {
    expect(moduleOf(`${S}newdir/a.ts`, MODULES)).toBe('newdir');
  });
  it('answers null outside core', () => {
    expect(moduleOf('packages/web-v2/src/a.ts', MODULES)).toBeNull();
  });
});

describe('kindFindings', () => {
  it('reports a directory with no kind, and only that one', () => {
    const f = kindFindings(['issues', 'newdir'], MODULES);
    expect(f.map((x) => x.module)).toEqual(['newdir']);
  });
});

describe('directionFindings', () => {
  it('allows each kind to import the kinds below it', () => {
    const ok = [
      edge('mcp/a.ts', 'feedback/index.ts'),
      edge('runs/a.ts', 'issues/index.ts'),
      edge('feedback/a.ts', 'integrations/github/index.ts'),
      edge('feedback/a.ts', 'suggestions/index.ts'),
      edge('issues/a.ts', 'db/client.ts'),
    ];
    expect(directionFindings(ok, MODULES)).toEqual([]);
  });
  it('reports an import pointing back up, naming both kinds', () => {
    const f = directionFindings(
      [edge('lib/a.ts', 'feedback/service.ts'), edge('issues/a.ts', 'runs/read.ts')],
      MODULES,
    );
    expect(f.map((x) => x.detail)).toEqual([
      'platform lib imports domain feedback (feedback/service.ts)',
      'kernel issues imports read-model runs (runs/read.ts)',
    ]);
  });
  it('reports a door reaching an adapter and an adapter reaching a domain', () => {
    const f = directionFindings(
      [
        edge('index.ts', 'integrations/github/x.ts'),
        edge('integrations/github/x.ts', 'feedback/index.ts'),
      ],
      MODULES,
    );
    expect(f.map((x) => x.module)).toEqual(['(root)', 'integrations/github']);
  });
  it('ignores test files and imports inside one module', () => {
    const f = directionFindings(
      [edge('lib/a.test.ts', 'feedback/x.ts'), edge('feedback/a.ts', 'feedback/b.ts')],
      MODULES,
    );
    expect(f).toEqual([]);
  });
});

describe('publicFaceFindings', () => {
  it('accepts an import of the index and any platform file', () => {
    const f = publicFaceFindings(
      [edge('mcp/a.ts', 'feedback/index.ts'), edge('feedback/a.ts', 'db/schema.ts')],
      MODULES,
    );
    expect(f).toEqual([]);
  });
  it('reports an import of an internal file', () => {
    const f = publicFaceFindings([edge('mcp/a.ts', 'feedback/service.ts')], MODULES);
    expect(f).toEqual([
      {
        rule: 'public-face',
        module: 'mcp',
        file: `${S}mcp/a.ts`,
        detail: 'imports feedback/service.ts, an internal of feedback',
      },
    ]);
  });
});

describe('cycleFindings', () => {
  it('names every module in a cycle and leaves the rest out', () => {
    const { findings, cycles } = cycleFindings(
      [
        edge('feedback/a.ts', 'suggestions/b.ts'),
        edge('suggestions/b.ts', 'feedback/c.ts'),
        edge('mcp/a.ts', 'feedback/a.ts'),
      ],
      MODULES,
    );
    expect(cycles).toEqual([['feedback', 'suggestions']]);
    expect(findings.map((f) => f.module).sort()).toEqual(['feedback', 'suggestions']);
  });
  it('finds no cycle in a one-way chain', () => {
    expect(
      cycleFindings(
        [edge('mcp/a.ts', 'feedback/a.ts'), edge('feedback/a.ts', 'issues/a.ts')],
        MODULES,
      ).cycles,
    ).toEqual([]);
  });
});

describe('tables', () => {
  const tables = declaredTables([
    "export const suggestions = pgTable('suggestions', {});\nexport const feedback = pgTable(\n  'feedback_items', {});",
  ]);
  it('reads each pgTable export and its SQL name', () => {
    expect([...tables]).toEqual([
      ['suggestions', 'suggestions'],
      ['feedback', 'feedback_items'],
    ]);
  });
  it('finds drizzle writes and raw SQL writes, not reads', () => {
    const text = [
      'await tx.update(suggestions).set({ x: 1 });',
      'await db.select().from(suggestions);',
      'await tx.insert(schema.feedback).values({});',
      'await tx.execute(sql`DELETE FROM feedback_items WHERE id = 1`);',
    ].join('\n');
    expect(tableWrites(text, tables)).toEqual([
      { table: 'suggestions', op: 'update', line: 1 },
      { table: 'feedback', op: 'insert', line: 3 },
      { table: 'feedback', op: 'sql', line: 4 },
    ]);
  });
  it('reports a write by a module other than the owner, and lists the table as multi-writer', () => {
    const { owners } = parseDeclaration({ modules: MODULES });
    const { findings, multiWriter } = tableWriterFindings(
      [
        { table: 'suggestions', module: 'suggestions', file: 'a', line: 1 },
        { table: 'suggestions', module: 'feedback', file: 'b', line: 9 },
        { table: 'orphan', module: 'feedback', file: 'c', line: 2 },
      ],
      owners,
    );
    expect(findings.map((f) => f.detail)).toEqual([
      'writes suggestions, owned by suggestions',
      'writes orphan, which declares no owner',
    ]);
    expect(multiWriter).toEqual({ suggestions: ['feedback', 'suggestions'] });
  });
});

describe('routeQueryFindings', () => {
  const text =
    'const rows = await db\n  .select()\n  .from(x);\nawait db.transaction(async (tx) => tx.insert(y));';
  it('counts database calls in a route file', () => {
    expect(routeQueryFindings(`${S}orgs/routes.ts`, text, 'orgs')[0].detail).toBe(
      '3 database call(s) in a route file',
    );
    expect(routeQueryFindings(`${S}orgs/members-routes.ts`, text, 'orgs')).toHaveLength(1);
  });
  it('leaves a service file alone, and a route file that calls a service', () => {
    expect(routeQueryFindings(`${S}orgs/service.ts`, text, 'orgs')).toEqual([]);
    expect(
      routeQueryFindings(`${S}orgs/routes.ts`, 'return answer(c, await createOrg(input));', 'orgs'),
    ).toEqual([]);
  });
});

describe('refusalFindings', () => {
  const details = (text, kind = 'domain') =>
    refusalFindings('f.ts', text, 'm', kind).map((f) => f.detail);
  it('reports a rule status thrown as an HTTPException, not a transport one', () => {
    expect(
      details("throw new HTTPException(409, { message: 'x' });\nthrow new HTTPException(404);"),
    ).toEqual(["throws HTTPException 409 in the error handler's shape, not the envelope"]);
  });
  it('lets platform answer 403 for transport, but not a domain', () => {
    expect(details('throw new HTTPException(403);', 'platform')).toEqual([]);
    expect(details('throw new HTTPException(403);', 'domain')).toHaveLength(1);
  });
  it('reports a domain error class, not an adapter one', () => {
    expect(details('export class VerdictRefused extends HTTPException {}')).toEqual([
      'declares error class VerdictRefused; a rule refusal is the envelope, an invariant a plain Error',
    ]);
    expect(details('class GitHubApiError extends Error {}', 'adapter')).toEqual([]);
  });
  it('reports a rule code thrown as text, not a transport code', () => {
    expect(
      details(
        "throw new Error('FORBIDDEN: not a writer');\nthrow new Error(`BAD_REQUEST: list needs id`);",
      ),
    ).toEqual(['throws the code FORBIDDEN as text']);
  });
  it('reports refusal codes declared in core', () => {
    expect(details('export const REQUIREMENT_REFUSAL_CODES = [] as const;')).toEqual([
      'declares refusal codes REQUIREMENT_REFUSAL_CODES in core, not in contracts',
    ]);
  });
});

describe('statusWriteFindings', () => {
  it('reports a status set outside the kernel transition', () => {
    const f = statusWriteFindings(
      'f.ts',
      "await tx.update(jobs).set({ status: 'done', endedAt: now });",
      'devices',
    );
    expect(f.map((x) => x.detail)).toEqual([
      'writes a status on jobs outside the kernel transition',
    ]);
  });
  it('reports a named status column too', () => {
    expect(
      statusWriteFindings('f.ts', 'db.update(designs).set({ designStatus: s })', 'workflows'),
    ).toHaveLength(1);
  });
  it('accepts the same write inside the transition module, and a write with no status', () => {
    expect(
      statusWriteFindings('f.ts', "tx.update(jobs).set({ status: 'done' })", 'lifecycle'),
    ).toEqual([]);
    expect(statusWriteFindings('f.ts', 'tx.update(jobs).set({ endedAt: now })', 'devices')).toEqual(
      [],
    );
  });
});

describe('markers and baseline', () => {
  const findings = [
    { rule: 'direction', module: 'lib', file: 'a', detail: 'x' },
    { rule: 'cycle', module: 'lib', file: 'a', detail: 'y' },
    { rule: 'refusal', module: 'feedback', file: 'b', line: 3, detail: 'z' },
  ];
  const byModule = tally(findings, MODULES, ['lib', 'feedback', 'issues']);
  it('marks a module Wrong with the rules it fails, due for rewrite at two', () => {
    const doc = markers(byModule, { atSha: 'abc', cycles: [], multiWriter: {} });
    expect(doc.nodes.lib).toMatchObject({
      mark: 'wrong',
      aspects: ['direction', 'cycle'],
      rewriteDue: true,
    });
    expect(doc.nodes.feedback).toMatchObject({
      mark: 'wrong',
      aspects: ['refusal'],
      rewriteDue: false,
    });
    expect(doc.nodes.issues).toMatchObject({ mark: 'matched', aspects: [], rewriteDue: false });
    expect(doc.nodes.feedback.evidence[0]).toEqual({
      rule: 'refusal',
      kind: 'repo',
      file: 'b',
      line: 3,
      detail: 'z',
      atSha: 'abc',
    });
    expect(doc.totals).toMatchObject({ direction: 1, cycle: 1, refusal: 1, 'table-writer': 0 });
  });
  it('freezes counts by rule and module, and says which rose and which fell', () => {
    const baseline = baselineOf(byModule);
    expect(baseline.frozen).toEqual({ 'direction|lib': 1, 'cycle|lib': 1, 'refusal|feedback': 1 });
    const later = tally(
      [...findings.slice(1), { rule: 'refusal', module: 'feedback', file: 'c', detail: 'w' }],
      MODULES,
      ['lib', 'feedback'],
    );
    expect(compareBaseline(later, baseline)).toEqual({
      rose: [{ key: 'refusal|feedback', was: 1, now: 2 }],
      fell: [{ key: 'direction|lib', was: 1, now: 0 }],
    });
  });
});
