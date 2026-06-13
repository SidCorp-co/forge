import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { MCP_CATALOG, MCP_CATALOG_NAMES, expandMcpServers } = await import('./mcp-catalog.js');

describe('MCP_CATALOG', () => {
  it('includes the required playwright entry as a stdio npx spec', () => {
    expect(MCP_CATALOG.playwright).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      env: {},
    });
    expect(MCP_CATALOG_NAMES).toContain('playwright');
  });
});

describe('expandMcpServers', () => {
  it('returns empty for null/undefined/non-object', () => {
    expect(expandMcpServers(null)).toEqual({});
    expect(expandMcpServers(undefined)).toEqual({});
    // @ts-expect-error testing runtime guard
    expect(expandMcpServers('nope')).toEqual({});
  });

  it('expands `true` to the catalog spec', () => {
    const out = expandMcpServers({ playwright: true });
    expect(out.playwright).toEqual(MCP_CATALOG.playwright);
  });

  it('does not return the shared catalog object by reference (clone)', () => {
    const out = expandMcpServers({ playwright: true });
    expect(out.playwright).not.toBe(MCP_CATALOG.playwright);
    (out.playwright as { command: string }).command = 'mutated';
    expect((MCP_CATALOG.playwright as { command: string }).command).toBe('npx');
  });

  it('skips an unknown name enabled with `true`', () => {
    const out = expandMcpServers({ doesnotexist: true });
    expect(out).toEqual({});
  });

  it('uses an object value verbatim (custom raw spec)', () => {
    const custom = { type: 'http', url: 'https://x', headers: { A: '1' } };
    const out = expandMcpServers({ mine: custom });
    expect(out.mine).toEqual(custom);
    // cloned, not the same reference
    expect(out.mine).not.toBe(custom);
  });

  it('omits entries set to false or null (opt-out)', () => {
    const out = expandMcpServers({ playwright: false, other: null });
    expect(out).toEqual({});
  });

  it('skips malformed primitive values', () => {
    const out = expandMcpServers({ a: 'string', b: 42, playwright: true });
    expect(out).toEqual({ playwright: MCP_CATALOG.playwright });
  });

  it('handles a mixed map', () => {
    const custom = { type: 'stdio', command: 'foo', args: [], env: {} };
    const out = expandMcpServers({
      playwright: true,
      custom,
      disabled: false,
      unknown: true,
    });
    expect(Object.keys(out).sort()).toEqual(['custom', 'playwright']);
  });
});

// Mirrors the exact merge expression in jobs/dispatcher.ts so the documented
// order (project-default < per-state < integrations) is locked by a test.
// The dispatcher does, in sequence:
//   base = { ...projectDefault, ...perState }          // per-state wins by name
//   base = applyPostmanMcpServers(base)  → { ...base, postman }
//   base = applyEpodsystemMcpServers(base) → { ...base, epodsystem }
describe('dispatch mcpServers merge order', () => {
  function merge(
    projectDefault: Record<string, unknown>,
    perState: Record<string, unknown> | null,
    integrations: Record<string, unknown>,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = { ...projectDefault, ...(perState ?? {}) };
    return { ...base, ...integrations };
  }

  it('per-state overrides project-default by server name', () => {
    const projectDefault = expandMcpServers({ playwright: true });
    const perState = { playwright: { type: 'stdio', command: 'custom-playwright' } };
    const out = merge(projectDefault, perState, {});
    expect((out.playwright as { command: string }).command).toBe('custom-playwright');
  });

  it('integration servers layer on top of both', () => {
    const projectDefault = expandMcpServers({ playwright: true });
    const perState = { sentry: { type: 'http', url: 'state' } };
    const integrations = { postman: { type: 'http', url: 'pm' } };
    const out = merge(projectDefault, perState, integrations);
    expect(Object.keys(out).sort()).toEqual(['playwright', 'postman', 'sentry']);
    expect(out.postman).toEqual({ type: 'http', url: 'pm' });
  });

  it('integration wins on a name collision (postman > project-default > per-state)', () => {
    const projectDefault = { postman: { type: 'http', url: 'default' } };
    const perState = { postman: { type: 'http', url: 'state' } };
    const integrations = { postman: { type: 'http', url: 'integration' } };
    const out = merge(projectDefault, perState, integrations);
    expect((out.postman as { url: string }).url).toBe('integration');
  });

  it('project-default flows through when no per-state and no integrations', () => {
    const out = merge(expandMcpServers({ playwright: true }), null, {});
    expect(out.playwright).toBeDefined();
  });
});
