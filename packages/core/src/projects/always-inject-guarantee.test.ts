/**
 * ISS-936 — `alwaysInject` renders a project's fact under "Hard rules … Follow
 * them exactly" and nothing reads the rule back. These assertions hold the
 * sentence that says so on every surface that offers the flag, and hold the one
 * surface that must NOT carry it.
 *
 * The tests that matter are the two source reads: `project-facts-tab.tsx` is in
 * another package and cannot import the constant, and `resolve.ts` is asserted
 * for an ABSENCE, which no interpolation can guarantee.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FORGE_GUIDES } from '../guides/registry.js';
import { ALWAYS_INJECT_GUARANTEE_NOTE } from './project-facts.js';

// cm:guard the MCP tool module reaches `config/env.js` transitively and throws at IMPORT without DATABASE_URL/JWT_SECRET. Only `description` is under test, so env and the client are stubbed rather than the assertion weakened to a source grep — a grep for the identifier proves it is referenced, never that it lands in the text an agent reads.
vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { forgeConfigTool } = await import('../mcp/tools/forge-config.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, '../../../..');

function read(relative: string): string {
  return readFileSync(resolvePath(REPO, relative), 'utf8');
}

/** Comment lines only — a `cm:` annotation naming the constant is not a use of it. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('{/*');
    })
    .join('\n');
}

// cm:guard the tool factory is context-scoped and a real `ctx` needs a principal and a DB. Only `description` is under test, so a cast of the minimum shape is correct here.
const fakeCtx = { principal: {}, deprecations: new Set<string>() } as never;

describe('ALWAYS_INJECT_GUARANTEE_NOTE', () => {
  it('says the fact is guaranteed read, and where that is visible afterwards', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('is READ');
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain(
      'spliced verbatim into every agent system prompt',
    );
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('visible afterwards on the job');
  });

  it('says compliance is not verified, in all three of the ways it is not', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('never that it was DONE');
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('Whether it was followed is recorded nowhere');
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('no gate refuses a step that ignored it');
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('no surface counts how often it was obeyed');
  });

  it('names the one obligation on this deployment that does have a readback', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('ux_contract_rules');
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('ux_findings');
  });

  it('promises nothing about enforcement', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).not.toMatch(
      /must always follow|will be followed|enforced|guaranteed to be followed/,
    );
  });

  // cm:guard one string renders into an MCP tool description, a terminal-read guide body and a browser paragraph. Markdown would be swallowed by exactly one of the three.
  it('carries no markdown', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).not.toContain('`');
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).not.toContain('**');
  });
});

describe('the surfaces that interpolate it', () => {
  it("`forge_config`'s tool description", () => {
    expect(forgeConfigTool(fakeCtx).description).toContain(ALWAYS_INJECT_GUARANTEE_NOTE);
  });

  it('the `project-settings-and-test-credentials` guide', () => {
    const guide = FORGE_GUIDES.find((g) => g.slug === 'project-settings-and-test-credentials');
    expect(guide?.body).toContain(ALWAYS_INJECT_GUARANTEE_NOTE);
  });

  it('the settings tab, which reads it off its own GET rather than restating it', () => {
    const source = read('packages/core/src/projects/project-facts-routes.ts');
    expect(source).toContain('alwaysInjectGuarantee: ALWAYS_INJECT_GUARANTEE_NOTE');
  });
});

// cm:guard these read SOURCE because neither claim can be made any other way: the tab is in another package and cannot import this constant, and the prompt's claim is an ABSENCE.
describe('the two surfaces the constant cannot reach', () => {
  const TAB = 'packages/web-v2/src/features/project-settings/components/project-facts-tab.tsx';

  it(`${TAB} renders the served sentence`, () => {
    expect(read(TAB)).toContain('alwaysInjectGuarantee');
  });

  // cm:guard the promise spanned two JSX lines when it was there, so the whitespace is collapsed before matching — a line-by-line grep for it went green while the sentence was still on the screen.
  it(`${TAB} makes the owner no promise that the rule is followed`, () => {
    const copy = withoutComments(read(TAB)).replace(/\s+/g, ' ');
    expect(copy).not.toMatch(/the agent must|must always follow|rules? the agent (must|will)/);
  });

  it('the agent prompt keeps its instruction and does NOT carry the guarantee', () => {
    const source = read('packages/core/src/prompt/facts/resolve.ts');
    expect(source).toContain('Follow them exactly.');
    expect(withoutComments(source)).not.toContain('ALWAYS_INJECT_GUARANTEE_NOTE');
  });
});
