/**
 * The measurement has to separate the catalog from the context around it, which is exactly what the
 * aggregate ratio in `chat_logs.usage` cannot do — so the divergence case is asserted here rather
 * than only printed, and a token figure that lost its provenance label is a failure.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    ANTHROPIC_API_URL: 'https://proxy.example/v1',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const {
  CHARS_PER_TOKEN,
  PRICING,
  costCases,
  catalogVariants,
  countCatalogTokens,
  divergenceCase,
  measureLiveCatalog,
  serializeCatalogForWire,
} = await import('./tool-catalog-cost.js');
const { CHAT_TOOL_ALLOWLIST } = await import('./tools/registry.js');

interface WireTool {
  name: string;
  description?: string;
  input_schema: { type: string };
  cache_control?: { type: string };
}

describe('the catalog, as the provider sees it', () => {
  it('serializes every allowlisted factory with the schema key the Messages wire names', () => {
    const { wire, toolCount } = measureLiveCatalog();
    expect(toolCount).toBe(CHAT_TOOL_ALLOWLIST.length);
    for (const tool of wire as WireTool[]) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it('carries the cache marker on the last tool and on no other', () => {
    const wire = serializeCatalogForWire([
      { type: 'function', function: { name: 'a', parameters: {} } },
      { type: 'function', function: { name: 'b', parameters: {} } },
    ]) as WireTool[];
    expect(wire[0]?.cache_control).toBeUndefined();
    expect(wire[1]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('labels an uncounted figure as an estimate and names its divisor', () => {
    const { chars, tokens } = measureLiveCatalog();
    expect(tokens.provenance).toBe('estimated');
    expect(tokens.divisor).toBe(CHARS_PER_TOKEN);
    expect(tokens.tokens).toBe(Math.ceil(chars / CHARS_PER_TOKEN));
  });
});

describe('counting the catalog through the provider', () => {
  const counter = (byRequest: (body: string) => Response) =>
    vi.fn(async (_url: string, init?: { body?: string }) =>
      byRequest(init?.body ?? ''),
    ) as unknown as typeof fetch;

  it('says which credential is missing rather than reporting a number', async () => {
    expect(await countCatalogTokens([], { apiKey: undefined })).toEqual({
      ok: false,
      reason: 'no-credential',
    });
  });

  it('measures the catalog as the difference between the two counts, not the larger one', async () => {
    const fetchImpl = counter((body) =>
      body.includes('"tools"')
        ? new Response(JSON.stringify({ input_tokens: 110 }), { status: 200 })
        : new Response(JSON.stringify({ input_tokens: 10 }), { status: 200 }),
    );
    expect(await countCatalogTokens([{ name: 't' }], { apiKey: 'k', fetchImpl })).toEqual({
      ok: true,
      figure: { tokens: 100, provenance: 'measured' },
    });
  });

  it('counts against the base ANTHROPIC_API_URL names, not the vendor host', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ input_tokens: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    await countCatalogTokens([], { apiKey: 'k', fetchImpl });
    expect(urls).toEqual([
      'https://proxy.example/v1/messages/count_tokens',
      'https://proxy.example/v1/messages/count_tokens',
    ]);
  });

  it('reads nothing out of a body that is not JSON at all', async () => {
    const fetchImpl = counter(() => new Response('{', { status: 200 }));
    expect(await countCatalogTokens([], { apiKey: 'k', fetchImpl })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('distinguishes a refused call from a missing credential', async () => {
    const fetchImpl = counter(() => new Response('nope', { status: 401 }));
    expect(await countCatalogTokens([], { apiKey: 'k', fetchImpl })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('does not throw when the provider is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await countCatalogTokens([], { apiKey: 'k', fetchImpl })).toEqual({
      ok: false,
      reason: 'provider-refused',
    });
  });

  it('reads nothing out of an answer it cannot parse', async () => {
    const fetchImpl = counter(() => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    expect(await countCatalogTokens([], { apiKey: 'k', fetchImpl })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });
});

describe('the serialization a quoted figure came from', () => {
  it('separates the four shapes, the bound wire form being the one priced', () => {
    const catalog = measureLiveCatalog();
    const variants = new Map(catalogVariants(catalog));
    expect(variants.get('wire, project-bound — what this module prices')).toBe(catalog.chars);
    for (const [label, chars] of variants) {
      expect(chars, label).toBeGreaterThan(0);
    }
    expect(variants.size).toBe(4);
  });
});

describe('what the catalog costs per request', () => {
  it('prices the cold write ABOVE paying full rate, and the warm read below it', () => {
    const [uncached, cold, warm] = costCases(8000, 2000);
    expect(cold?.dollars).toBeGreaterThan(uncached?.dollars ?? 0);
    expect(uncached?.dollars).toBeGreaterThan(warm?.dollars ?? 0);
  });

  it('bills the history at the full input rate in every case', () => {
    const historyDollars = (2000 / 1_000_000) * PRICING.inputPerMTok;
    for (const c of costCases(8000, 2000)) {
      expect(c.dollars).toBeGreaterThan(historyDollars);
    }
    const warm = costCases(8000, 2000)[2];
    expect(warm?.dollars).toBeCloseTo(
      historyDollars + (8000 / 1_000_000) * PRICING.inputPerMTok * PRICING.cacheReadMultiplier,
      12,
    );
  });
});

describe('the aggregate ratio measures the history, not the catalog', () => {
  const rows = divergenceCase(8000, [2000, 20_000]);

  it('reports different ratios for the same cached catalog', () => {
    expect(rows[0]?.aggregateRatio).not.toBeCloseTo(rows[1]?.aggregateRatio ?? 0, 3);
    expect(rows[0]?.aggregateRatio).toBeCloseTo(8000 / 10_000, 6);
    expect(rows[1]?.aggregateRatio).toBeCloseTo(8000 / 28_000, 6);
  });

  it('saves the same tokens and the same dollars in both', () => {
    expect(rows[0]?.prefixSavingTokens).toBe(rows[1]?.prefixSavingTokens);
    expect(rows[0]?.prefixSavingDollars).toBe(rows[1]?.prefixSavingDollars);
    expect(rows[0]?.prefixSavingTokens).toBeCloseTo(7200, 6);
  });

  it('reports the whole prompt in cachedPromptTokens/promptTokens, which is why it diverges', () => {
    expect(rows[0]?.promptTokens).toBe(10_000);
    expect(rows[0]?.cachedPromptTokens).toBe(8000);
  });
});
