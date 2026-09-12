/**
 * The measurement has to separate the catalog from the context around it, which is exactly what the
 * aggregate ratio in `chat_logs.usage` cannot do — so the divergence case is asserted here rather
 * than only printed, and a token figure that lost its provenance label is a failure.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const {
  CHARS_PER_TOKEN,
  main,
  PRICING,
  costCases,
  catalogVariants,
  countCatalogTokens,
  divergenceCase,
  measureLiveCatalog,
  serializeCatalogForWire,
  uncappedCatalogChars,
} = await import('./tool-catalog-cost.js');
const { CHAT_TOOL_ALLOWLIST } = await import('./tools/registry.js');
const { DESCRIPTION_CAP } = await import('./tools/mcp-adapter.js');
const { buildChatToolContext } = await import('./tools/principal.js');

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

  it('sees the chat cap in the wire it measured, by the marker the adapter appends', async () => {
    const { DESCRIPTION_CAP, truncate } = await import('./tools/mcp-adapter.js');
    expect(truncate('x'.repeat(DESCRIPTION_CAP + 1), DESCRIPTION_CAP)).toContain('[truncated]');
    const { wire } = measureLiveCatalog();
    const cut = (wire as WireTool[]).filter((t) => t.description?.includes('[truncated]'));
    expect(cut.length).toBeGreaterThan(0);
    for (const tool of cut) {
      expect(tool.description?.length).toBe(DESCRIPTION_CAP + 13);
    }
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
    vi.stubEnv('ANTHROPIC_API_URL', 'https://proxy.example/v1');
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
    vi.unstubAllEnvs();
  });

  it('falls back to the vendor host that config/env.ts defaults to', async () => {
    vi.stubEnv('ANTHROPIC_API_URL', undefined);
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ input_tokens: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    await countCatalogTokens([], { apiKey: 'k', fetchImpl });
    expect(urls[0]).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    vi.unstubAllEnvs();
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
    expect(variants.size).toBe(5);
  });

  // cm:guard the uncapped shape MUST be derived, never carried: the report quotes a figure for it, and a variant list that cannot produce that figure leaves the quote unfalsifiable (ISS-983 F1)
  it('derives the uncapped shape, and it is larger than the capped chat one', () => {
    const catalog = measureLiveCatalog();
    const variants = new Map(catalogVariants(catalog));
    const uncapped = variants.get('uncapped, descriptions whole — the chat nine before the cap');
    expect(uncapped).toBeGreaterThan(catalog.chars);
  });

  // cm:guard no variant label may claim `/mcp`: that door is `mcp/server.ts`'s ListToolsRequestSchema handler, a different tool list under a different key spelling, and naming it here is the substitution this module exists to refuse (ISS-983)
  it('claims no variant is the /mcp door, because none of them is', () => {
    const catalog = measureLiveCatalog();
    for (const [label] of catalogVariants(catalog)) {
      expect(label).not.toMatch(/mcp/i);
    }
  });

  it('reads the uncapped shape past the cap the chat door applies', () => {
    const ctx = buildChatToolContext({
      userId: '00000000-0000-0000-0000-000000000000',
      projectId: '00000000-0000-0000-0000-000000000000',
      projectSlug: 'measurement',
    });
    const whole = uncappedCatalogChars(ctx);
    const longest = Math.max(
      ...CHAT_TOOL_ALLOWLIST.map((spec) => spec.factory(ctx).description.length),
    );
    expect(longest).toBeGreaterThan(DESCRIPTION_CAP);
    expect(whole).toBeGreaterThan(DESCRIPTION_CAP * CHAT_TOOL_ALLOWLIST.length);
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

describe('every token figure the run prints says where it came from', () => {
  const LABELS = /\((measured|estimated, chars\/\d+|chosen[^)]*|declared[^)]*)\)/;

  it('labels every line that states a token count, with no provider credential', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
      lines.push(a.join(' '));
    });
    await main();
    log.mockRestore();
    vi.unstubAllEnvs();

    const tokenLines = lines
      .flatMap((l) => l.split('\n'))
      .filter((l) => /\btokens?\b/.test(l) && /\d/.test(l))
      .filter((l) => !l.startsWith('every token AND dollar figure below is derived'));
    expect(tokenLines.length).toBeGreaterThan(4);
    for (const line of tokenLines) {
      expect(line, line).toMatch(LABELS);
    }
  });

  it('inherits the catalog figure label onto everything derived from it', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
      lines.push(a.join(' '));
    });
    await main();
    log.mockRestore();
    expect(
      lines.some((l) =>
        l.includes(
          `every token AND dollar figure below is derived from the catalog figure, so each one is estimated, chars/${CHARS_PER_TOKEN}`,
        ),
      ),
    ).toBe(true);
  });
});

describe('the catalog splits into three buckets that sum to the whole (ISS-983 F2)', () => {
  // cm:guard `chars - described` is NOT schema — it also holds tool names, JSON punctuation, the array framing and the cache_control marker. Reporting it as schema overstates what a schema trim could ever reach, which is the one question this module is asked.
  it('names wire framing as itself rather than folding it into schema', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
      lines.push(a.join(' '));
    });
    await main();
    log.mockRestore();

    const sum = lines.flatMap((l) => l.split('\n')).find((l) => l.includes('wire framing'));
    expect(sum, 'no bucket-sum line was printed').toBeDefined();
    const m = (sum ?? '').match(/([\d,]+) \+ ([\d,]+) \+ ([\d,]+) = ([\d,]+)\./);
    expect(m, `no A + B + C = D in: ${sum}`).not.toBeNull();
    const [described, schema, framing, total] = (m ?? [])
      .slice(1)
      .map((n) => Number(n.replace(/,/g, ''))) as [number, number, number, number];
    expect(described + schema + framing).toBe(total);
    expect(framing).toBeGreaterThan(0);
    expect(sum).toContain('wire framing');
  });

  it('measures schema as the schemas themselves, not as a remainder', () => {
    const catalog = measureLiveCatalog();
    const schema = (catalog.wire as { input_schema?: unknown }[]).reduce(
      (n, t) => n + JSON.stringify(t.input_schema).length,
      0,
    );
    const described = (catalog.wire as { description?: string }[]).reduce(
      (n, t) => n + (t.description ?? '').length,
      0,
    );
    expect(schema).toBeLessThan(catalog.chars - described);
  });
});

describe('every DOLLAR figure says where it came from too (ISS-983 F3)', () => {
  const LABELS = /\((measured|estimated, chars\/\d+|chosen[^)]*|declared[^)]*)\)/;

  it('labels each dollar figure individually, not once per block', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
      lines.push(a.join(' '));
    });
    await main();
    log.mockRestore();
    vi.unstubAllEnvs();

    const dollarLines = lines
      .flatMap((l) => l.split('\n'))
      .filter((l) => /\$[\d.]/.test(l))
      .filter((l) => !l.startsWith('rates:'))
      .filter((l) => !l.includes('derived from the catalog figure'));
    expect(dollarLines.length).toBeGreaterThan(3);
    for (const line of dollarLines) {
      expect(line, line).toMatch(LABELS);
    }
  });
});
