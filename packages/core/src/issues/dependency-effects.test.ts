/**
 * ISS-935 — the pair nothing held: `hasChildIssues` reads one dependency kind
 * to waive the work-evidence gate, and six surfaces tell an agent what that
 * kind does. Four of them interpolate `WORK_EVIDENCE_WAIVER_NOTE`, so they
 * cannot drift; the other two are a `cm:guard` comment and a markdown file,
 * and these are the assertions that hold those.
 *
 * The test that matters is `the two surfaces that cannot interpolate it`: change
 * `WORK_EVIDENCE_WAIVER_KIND` and it names the file that did not follow.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { issueDependencyKinds } from '../db/schema.js';
import { FORGE_GUIDES } from '../guides/registry.js';
import { FORGE_FACTS } from '../prompt/facts/registry.js';
import {
  describeDependencyKind,
  WORK_EVIDENCE_WAIVER_KIND,
  WORK_EVIDENCE_WAIVER_NOTE,
} from './dependency-effects.js';

// cm:guard the MCP tool modules reach `config/env.js` transitively (via `db/client.js` and `embeddings/index.ts`), which throws at IMPORT without DATABASE_URL/JWT_SECRET. Only the `description` string is under test, so env and the client are stubbed rather than the assertion weakened to a source grep — a grep for the identifier proves it is referenced, never that it lands in the text an agent reads.
vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { forgeProjectPmTool } = await import('../mcp/tools/forge-project-pm.js');
const { forgePmSetDependencyTool } = await import('../mcp/tools/forge-pm-set-dependency.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

function read(relative: string): string {
  return readFileSync(resolve(REPO, relative), 'utf8');
}

// cm:guard the tool factories are context-scoped, and a real `ctx` needs a principal and a DB. Only the `description` is under test, so a cast of the minimum shape is correct here — reaching for the real context would make a string assertion need a live database.
const fakeCtx = { principal: {}, deprecations: new Set<string>() } as never;

describe('describeDependencyKind', () => {
  it('names the waiver on exactly one kind', () => {
    const waiving = issueDependencyKinds.filter(
      (k) => describeDependencyKind(k).waivesWorkEvidence,
    );
    expect(waiving).toEqual([WORK_EVIDENCE_WAIVER_KIND]);
  });

  it('names dispatch gating on exactly `blocks`', () => {
    const gating = issueDependencyKinds.filter((k) => describeDependencyKind(k).gatesDispatch);
    expect(gating).toEqual(['blocks']);
  });

  it('gives the waiver kind the note every agent-facing surface renders', () => {
    expect(describeDependencyKind(WORK_EVIDENCE_WAIVER_KIND).note).toBe(WORK_EVIDENCE_WAIVER_NOTE);
  });

  it('never calls the waiver kind inert', () => {
    const note = describeDependencyKind(WORK_EVIDENCE_WAIVER_KIND).note;
    expect(note).toContain('work-evidence gate');
    expect(note).not.toMatch(/gates nothing|holds nothing back|no lifecycle of its own/);
  });
});

describe('the four surfaces that render the note', () => {
  it('the `issue-dependencies` guide', () => {
    const guide = FORGE_GUIDES.find((g) => g.slug === 'issue-dependencies');
    expect(guide?.body).toContain(WORK_EVIDENCE_WAIVER_NOTE);
  });

  it('the `relations` prompt fact', () => {
    const fact = FORGE_FACTS.find((f) => f.id === 'relations');
    expect(fact?.render()).toContain(WORK_EVIDENCE_WAIVER_NOTE);
  });

  it('the `forge_pm.set_dependency` tool description', () => {
    expect(forgePmSetDependencyTool(fakeCtx).description).toContain(WORK_EVIDENCE_WAIVER_NOTE);
  });

  it('the `forge_project_pm` action description', () => {
    expect(forgeProjectPmTool(fakeCtx).description).toContain(WORK_EVIDENCE_WAIVER_NOTE);
  });
});

// cm:guard these read SOURCE rather than behaviour on purpose: the waiver's other half is a `cm:guard` comment and a markdown file, and nothing else in the suite can see either. Assert on the KIND VALUE, never on the literal `decomposes` — an assertion that hard-codes the kind goes green after the very change this test exists to catch.
describe('the two surfaces that cannot interpolate it', () => {
  const surfaces = ['packages/core/src/db/schema.ts', 'docs/modules/issue-work/README.md'] as const;

  for (const path of surfaces) {
    it(`${path} names \`${WORK_EVIDENCE_WAIVER_KIND}\` as the kind that waives the gate`, () => {
      const text = read(path);
      const waiverSentences = text
        .split('\n')
        .filter((line) => /waives the ISS-786 work-evidence gate/.test(line));
      expect(waiverSentences.length).toBeGreaterThan(0);
      // cm:guard match the kind BACKTICKED, never bare — `schema.ts`'s waiver line also says "the parent lifecycle this kind once drove", so a bare-substring assertion went GREEN when the constant was planted as `parent`. Measured on ISS-935 before this line existed.
      expect(waiverSentences.join('\n')).toContain(`\`${WORK_EVIDENCE_WAIVER_KIND}\``);
    });
  }
});

describe('the query the surfaces describe', () => {
  const source = read('packages/core/src/pipeline/work-evidence.ts');

  it('filters on the constant, not a literal kind', () => {
    expect(source).toContain('eq(issueDependencies.kind, WORK_EVIDENCE_WAIVER_KIND)');
  });

  it('holds no bare dependency-kind literal', () => {
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n');
    for (const kind of issueDependencyKinds) {
      expect(code).not.toContain(`'${kind}'`);
    }
  });
});
