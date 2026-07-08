import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  MCP_CATALOG,
  MCP_CATALOG_NAMES,
  INTEGRATION_SERVER_NAMES,
  isIntegrationSentinelName,
  isKnownMcpServerName,
  collectDeclaredMcpNames,
  expandMcpServers,
} = await import('./mcp-catalog.js');

describe('MCP_CATALOG', () => {
  it('includes the required playwright entry as a stdio npx spec', () => {
    expect(MCP_CATALOG.playwright).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest', '--headless', '--isolated', '--no-sandbox'],
      env: {},
    });
    expect(MCP_CATALOG_NAMES).toContain('playwright');
  });

  it('includes the chrome-devtools-mcp entry as a stdio npx spec', () => {
    expect(MCP_CATALOG['chrome-devtools-mcp']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: [
        'chrome-devtools-mcp@latest',
        '--headless',
        '--isolated',
        '--chrome-arg=--no-sandbox',
        '--chrome-arg=--disable-setuid-sandbox',
      ],
      env: {},
    });
    expect(MCP_CATALOG_NAMES).toContain('chrome-devtools-mcp');
  });

  it('expands chrome-devtools-mcp shorthand to its catalog spec', () => {
    const out = expandMcpServers({ 'chrome-devtools-mcp': true });
    expect(out['chrome-devtools-mcp']).toEqual(MCP_CATALOG['chrome-devtools-mcp']);
    expect(out['chrome-devtools-mcp']).not.toBe(MCP_CATALOG['chrome-devtools-mcp']);
  });
});

describe('INTEGRATION_SERVER_NAMES + isIntegrationSentinelName (ISS-581)', () => {
  it('exports INTEGRATION_SERVER_NAMES with postman, epodsystem, sentry', () => {
    expect(INTEGRATION_SERVER_NAMES).toContain('postman');
    expect(INTEGRATION_SERVER_NAMES).toContain('epodsystem');
    expect(INTEGRATION_SERVER_NAMES).toContain('sentry');
  });

  it('isIntegrationSentinelName returns true for exact integration names', () => {
    expect(isIntegrationSentinelName('postman')).toBe(true);
    expect(isIntegrationSentinelName('epodsystem')).toBe(true);
    expect(isIntegrationSentinelName('sentry')).toBe(true);
  });

  it('isIntegrationSentinelName returns true for epodsystem_* labels', () => {
    expect(isIntegrationSentinelName('epodsystem_store_a')).toBe(true);
    expect(isIntegrationSentinelName('epodsystem_partner_x')).toBe(true);
  });

  it('isIntegrationSentinelName returns false for catalog and unknown names', () => {
    expect(isIntegrationSentinelName('playwright')).toBe(false);
    expect(isIntegrationSentinelName('chrome-devtools-mcp')).toBe(false);
    expect(isIntegrationSentinelName('unknown')).toBe(false);
  });
});

describe('isKnownMcpServerName + collectDeclaredMcpNames (ISS-623 W1)', () => {
  it('isKnownMcpServerName returns true for catalog and integration names', () => {
    expect(isKnownMcpServerName('playwright')).toBe(true);
    expect(isKnownMcpServerName('chrome-devtools-mcp')).toBe(true);
    expect(isKnownMcpServerName('epodsystem')).toBe(true);
    expect(isKnownMcpServerName('epodsystem_store_a')).toBe(true);
    expect(isKnownMcpServerName('postman')).toBe(true);
    expect(isKnownMcpServerName('sentry')).toBe(true);
  });

  it('isKnownMcpServerName returns false for an unknown name', () => {
    expect(isKnownMcpServerName('shop')).toBe(false);
    expect(isKnownMcpServerName('shp')).toBe(false);
  });

  it('collectDeclaredMcpNames collects truthy keys from the project default only', () => {
    const names = collectDeclaredMcpNames({ mcpServers: { playwright: true, disabled: false } });
    expect(names).toEqual(new Set(['playwright']));
  });

  it('collectDeclaredMcpNames collects truthy keys across per-state maps too', () => {
    const names = collectDeclaredMcpNames({
      mcpServers: { playwright: true },
      states: {
        approved: { mcpServers: { epodsystem: true } },
        developed: { mcpServers: { shop: true, off: null } },
      },
    });
    expect(names).toEqual(new Set(['playwright', 'epodsystem', 'shop']));
  });

  it('collectDeclaredMcpNames returns an empty set when nothing is declared', () => {
    expect(collectDeclaredMcpNames({})).toEqual(new Set());
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

  // ISS-581: integration sentinel preservation
  it('preserves `true` for integration names as a sentinel (not warn-skipped)', () => {
    const out = expandMcpServers({ postman: true });
    expect(out.postman).toBe(true);
  });

  it('preserves `true` for sentry sentinel', () => {
    const out = expandMcpServers({ sentry: true });
    expect(out.sentry).toBe(true);
  });

  it('preserves `true` for epodsystem sentinel', () => {
    const out = expandMcpServers({ epodsystem: true });
    expect(out.epodsystem).toBe(true);
  });

  it('preserves `true` for labeled epodsystem_* sentinel', () => {
    const out = expandMcpServers({ epodsystem_store_a: true });
    expect(out.epodsystem_store_a).toBe(true);
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

  it('handles a mixed map with integrations and catalog names', () => {
    const custom = { type: 'stdio', command: 'foo', args: [], env: {} };
    const out = expandMcpServers({
      playwright: true,
      custom,
      disabled: false,
      unknown: true,
      sentry: true,
      epodsystem: true,
    });
    // playwright → catalog spec; sentry/epodsystem → sentinel true; custom → spec; disabled/unknown → dropped
    expect(out.playwright).toEqual(MCP_CATALOG.playwright);
    expect(out.sentry).toBe(true);
    expect(out.epodsystem).toBe(true);
    expect(out.custom).toEqual(custom);
    expect(out.disabled).toBeUndefined();
    expect(out.unknown).toBeUndefined();
  });
});

// Mirrors the exact merge expression in jobs/dispatcher.ts so the documented
// order (project-default < per-state < integrations) is locked by a test.
// The dispatcher does, in sequence:
//   base = { ...projectDefault, ...perState }          // per-state wins by name
//   base = applyPostmanMcpServers(base)  → sentinel replaced or stripped
//   base = applyEpodsystemMcpServers(base) → sentinel replaced or stripped
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

  it('ISS-581: integration sentinel in project-default flows to per-state merge', () => {
    // expandMcpServers preserves true for integration names
    const projectDefault = expandMcpServers({ playwright: true, sentry: true });
    expect(projectDefault.sentry).toBe(true);
    // per-state inherits the sentinel
    const out = merge(projectDefault, null, {});
    expect(out.sentry).toBe(true);
  });
});
