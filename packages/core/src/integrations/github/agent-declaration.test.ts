/**
 * What github's declaration now says, and what a job's prompt says because of it.
 *
 * ISS-1074 criteria 1, 3 and 24. These are assertions about the DECLARATION rather than about a
 * call, because that is where the whole of outcome 3 lives: `grantHolds` answers false for any
 * provider declaring `agentPath.kind === 'none'` however its column reads, so a github that still
 * declared `none` would refuse every binding in the fleet and no test of the tool would notice —
 * they all mock the resolution.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const { registerAllIntegrations } = await import('../register-all.js');
const { getIntegration, listIntegrations } = await import('../registry.js');
const { grantHolds, agentAccessTier } = await import('../agent-access.js');
const { REGISTERED_TOOLS } = await import('../../mcp/registered-tools.js');
const { renderIntegrations } = await import('../../prompt/facts/resolve.js');

registerAllIntegrations();

describe('github declares the agent path ISS-1074 gave it', () => {
  it('is core-mediated and carries forge_github', () => {
    const decl = getIntegration('github');
    expect(decl?.capabilities.agentPath).toEqual({
      kind: 'core-mediated',
      tools: ['forge_github'],
    });
  });

  // cm:guard `direct-mcp` would render the App's private key into a runner box's MCP config. That key is the identity every write to every repository the installation covers is made under, so this assertion is a security boundary and not a tidiness one.
  it('is not direct-mcp, so the App key never reaches a box', () => {
    const decl = getIntegration('github');
    expect(decl?.capabilities.agentPath.kind).not.toBe('direct-mcp');
    expect(agentAccessTier(decl)).toBe('project-admin');
  });

  it('a binding reaches an agent only when its column says so', () => {
    const decl = getIntegration('github');
    expect(grantHolds(decl, { agentAccess: 'all' })).toBe(true);
    expect(grantHolds(decl, { agentAccess: 'none' })).toBe(false);
  });

  it('says in one line what the tool is for, and that nothing here merges', () => {
    const hint = getIntegration('github')?.usage?.hint ?? '';
    expect(hint).toContain('forge_github');
    expect(hint).toMatch(/nothing here merges/i);
    // The preamble is paid for by every job on every project with github connected.
    expect(hint.length).toBeLessThan(400);
  });
});

describe('every tool a provider declares is one the MCP server registers', () => {
  // ISS-1074 criterion 3, stated for the whole registry rather than for github alone: a declaration
  // naming a tool that is not registered advertises, in every prompt, a call that answers
  // `not_found` — and an agent reads that as a credential fault and retries.
  it('names no tool the server does not serve', () => {
    const declared = listIntegrations().flatMap((d) =>
      d.capabilities.agentPath.kind === 'none' ? [] : [...d.capabilities.agentPath.tools],
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const tool of declared) {
      expect(REGISTERED_TOOLS, `${tool} is declared by a provider and not registered`).toContain(
        tool,
      );
    }
  });
});

describe('what a job is told about a github binding it may not use', () => {
  // ISS-1074 criterion 24. The sentence is the generic one `resolve.ts` renders for any ungranted
  // binding; what this change made true is that github can now BE ungranted — while it declared
  // `none` the row rendered its usage hint and said nothing about a switch.
  it('renders the agent-access-off sentence instead of the usage hint', () => {
    const text = renderIntegrations([
      {
        provider: 'github',
        role: 'service',
        stages: [],
        lastHealthStatus: 'ok',
        instructions: null,
        hasOrgGuide: false,
        extraLine: null,
        agentGranted: false,
      },
    ]);
    expect(text).toMatch(/agent access is off/i);
    expect(text).toContain('Settings → Integrations');
    expect(text).not.toContain('forge_github');
  });

  it('renders the usage hint once the binding is granted', () => {
    const text = renderIntegrations([
      {
        provider: 'github',
        role: 'service',
        stages: [],
        lastHealthStatus: 'ok',
        instructions: null,
        hasOrgGuide: false,
        extraLine: null,
        agentGranted: true,
      },
    ]);
    expect(text).toContain('forge_github');
    expect(text).not.toMatch(/agent access is off/i);
  });
});
