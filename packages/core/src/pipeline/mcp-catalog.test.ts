import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  MCP_CATALOG,
  MCP_CATALOG_NAMES,
  applyStageFalseOptOuts,
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

// ISS-1071 deleted `INTEGRATION_SERVER_NAMES` and `isIntegrationSentinelName`. A sentinel key in
// this map was how a connected integration reached an agent; that question is now the
// `agent_access` column on the binding, so no integration has a name in this catalog at all. These
// assertions are the gravestone: they go red if a provider name is ever readmitted here, which is
// what would silently resurrect the two-places-to-look defect ISS-1038 was filed for.
describe('no integration has a name in the MCP catalog (ISS-1071)', () => {
  it('the catalog holds browser servers and nothing provider-shaped', () => {
    expect(MCP_CATALOG_NAMES.sort()).toEqual(['chrome-devtools-mcp', 'playwright']);
  });

  it('every former sentinel name is now an unknown server name', () => {
    for (const name of ['postman', 'sentry', 'epodsystem', 'epodsystem_store_a', 'coolify']) {
      expect(isKnownMcpServerName(name)).toBe(false);
    }
  });
});

describe('isKnownMcpServerName + collectDeclaredMcpNames (ISS-623 W1)', () => {
  it('isKnownMcpServerName returns true for catalog names only', () => {
    expect(isKnownMcpServerName('playwright')).toBe(true);
    expect(isKnownMcpServerName('chrome-devtools-mcp')).toBe(true);
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

  // ISS-1071: what used to be a preserved sentinel is now simply an unknown name. `true` for a
  // provider is dropped and warned here exactly as any other typo is, because the write schema
  // refuses it up front and nothing downstream reads it any more.
  it('drops `true` for every former integration sentinel name', () => {
    for (const name of ['postman', 'sentry', 'epodsystem', 'epodsystem_store_a']) {
      expect(expandMcpServers({ [name]: true })).toEqual({});
    }
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

  it('handles a mixed map with catalog names and former integration names', () => {
    const custom = { type: 'stdio', command: 'foo', args: [], env: {} };
    const out = expandMcpServers({
      playwright: true,
      custom,
      disabled: false,
      unknown: true,
      sentry: true,
      epodsystem: true,
    });
    // playwright → catalog spec; custom → spec; disabled/unknown/sentry/epodsystem → dropped
    expect(out.playwright).toEqual(MCP_CATALOG.playwright);
    expect(out.custom).toEqual(custom);
    expect(out.disabled).toBeUndefined();
    expect(out.unknown).toBeUndefined();
    expect(out.sentry).toBeUndefined();
    expect(out.epodsystem).toBeUndefined();
  });
});

// Mirrors the exact merge expression in jobs/dispatcher.ts so the documented
// order (project-default < per-state < integrations) is locked by a test.
// The dispatcher does, in sequence:
//   base = { ...projectDefault, ...perState }          // per-state wins by name
//   base = applyStageFalseOptOuts(base, rawStageMap)   // a stage `false` beats the project default
//   base = await applyGrantedMcpServers(projectId, base) // every GRANTED direct-mcp binding, by name
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

  it('a granted integration server is a real spec, never a bare `true`', () => {
    const projectDefault = expandMcpServers({ playwright: true, sentry: true });
    // `sentry: true` no longer survives expansion at all — there is no sentinel to inherit.
    expect(projectDefault.sentry).toBeUndefined();
    const out = merge(projectDefault, null, { sentry: { type: 'http', url: 'https://s' } });
    expect(out.sentry).toEqual({ type: 'http', url: 'https://s' });
  });
});

// ISS-1038 — the defect this carries forward. A stage declaring `sentry: false` meant "not at this
// stage", but `expandMcpServers` OMITS a `false` rather than recording it, and an omission cannot
// override the project default it is spread over: `{...projectDefault, ...expandedStage}` put the
// project's server back. The opt-out therefore has to be read off the RAW stage map, after the
// merge, which is the whole of what this function is for.
describe('applyStageFalseOptOuts (ISS-1038)', () => {
  it('a stage `false` removes a server the project default supplied', () => {
    const merged = { ...expandMcpServers({ playwright: true }) };
    const out = applyStageFalseOptOuts(merged, { playwright: false });
    expect(out.playwright).toBeUndefined();
  });

  it('`null` opts out the same way `false` does', () => {
    const out = applyStageFalseOptOuts({ playwright: {}, other: {} }, { playwright: null });
    expect(Object.keys(out)).toEqual(['other']);
  });

  it('leaves a server the stage did not mention', () => {
    const out = applyStageFalseOptOuts({ playwright: {}, other: {} }, { other: false });
    expect(Object.keys(out)).toEqual(['playwright']);
  });

  it('a stage `true`/spec is not an opt-out', () => {
    const spec = { type: 'http', url: 'x' };
    const out = applyStageFalseOptOuts({ playwright: spec }, { playwright: true });
    expect(out.playwright).toBe(spec);
  });

  it('opting out a name nothing supplied is a no-op, not an error', () => {
    const out = applyStageFalseOptOuts({ playwright: {} }, { absent: false });
    expect(out).toEqual({ playwright: {} });
  });

  it('never mutates the map it was given', () => {
    const merged = { playwright: {} };
    const out = applyStageFalseOptOuts(merged, { playwright: false });
    expect(merged.playwright).toBeDefined();
    expect(out).not.toBe(merged);
  });

  it('passes the merge through untouched when the stage declared nothing', () => {
    const merged = { playwright: {} };
    expect(applyStageFalseOptOuts(merged, null)).toBe(merged);
    expect(applyStageFalseOptOuts(merged, undefined)).toBe(merged);
    expect(applyStageFalseOptOuts(merged, {})).toBe(merged);
  });
});
