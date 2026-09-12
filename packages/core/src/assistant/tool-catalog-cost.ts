/**
 * ISS-983 — what the chat tool catalog costs per request, measured apart from the context around it.
 *
 * Run it: `pnpm --filter @forge/core measure:catalog-cost`; a census additionally needs
 * `FORGE_CENSUS_DATABASE_URL`. The report it feeds is
 * `docs/modules/agent-execution/tool-catalog-cost.md`.
 *
 * The catalog is re-derived rather than quoted, because it moves whenever a factory joins
 * `CHAT_TOOL_ALLOWLIST` or a `forge_*` description is edited, and it is serialized by calling
 * `toRequestBody` itself so that what is counted is what the wire carries.
 */

import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { openAiCompatUrl } from '../lib/openai-compat-url.js';
import { toRequestBody } from './providers/anthropic.js';
import type { ChatTool } from './providers/types.js';
import { buildChatToolContext } from './tools/principal.js';
import { buildProjectToolset } from './tools/registry.js';

// cm:edge naming -> packages/core/src/assistant/context-budget.ts — the same chars/4 the budget elides on, deliberately, so a token figure here and a token figure there mean one thing; an estimator that disagreed with the elider would price a request the elider had already cut
export const CHARS_PER_TOKEN = 4;

/** Anthropic list price in US dollars per million tokens, and the two multipliers caching applies to the input rate. */
export const PRICING = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  inputPerMTok: 2.0,
  outputPerMTok: 10.0,
  /** A 5-minute `ephemeral` write bills 1.25x the input rate. */
  cacheWriteMultiplier: 1.25,
  /** A read off a live entry bills 0.1x the input rate. */
  cacheReadMultiplier: 0.1,
  /** Under this many tokens a prefix silently does not cache at all on this model. */
  minimumCacheablePrefixTokens: 1024,
} as const;

export interface TokenFigure {
  tokens: number;
  /** `measured` only where the provider counted it; an estimate carries the divisor that produced it. */
  provenance: 'measured' | 'estimated';
  divisor?: number;
}

export interface CatalogMeasurement {
  toolCount: number;
  chars: number;
  wire: unknown[];
  tokens: TokenFigure;
}

/** The `tools` array exactly as `toRequestBody` puts it on the Messages wire, `cache_control` marker included. */
export function serializeCatalogForWire(tools: ChatTool[]): unknown[] {
  const body = toRequestBody(
    { model: PRICING.model, messages: [{ role: 'user', content: 'x' }], tools },
    1,
    undefined,
  );
  return (body.tools ?? []) as unknown[];
}

/** Build the live catalog through the same call the chat routes make, and size it. */
export function measureLiveCatalog(): CatalogMeasurement {
  const nilUuid = '00000000-0000-0000-0000-000000000000';
  const ctx = buildChatToolContext({
    userId: nilUuid,
    projectId: nilUuid,
    projectSlug: 'measurement',
  });
  const wire = serializeCatalogForWire(buildProjectToolset(ctx).tools);
  const chars = JSON.stringify(wire).length;
  return {
    toolCount: wire.length,
    chars,
    wire,
    tokens: {
      tokens: Math.ceil(chars / CHARS_PER_TOKEN),
      provenance: 'estimated',
      divisor: CHARS_PER_TOKEN,
    },
  };
}

/**
 * The same nine tools under every serialization anyone might have counted: the wire form this
 * module prices, the OpenAI-shaped toolset it is built from, the unbound form that keeps the
 * `projectId` a bound context strips, and the pretty-printed form. A catalog size quoted somewhere
 * else can be matched against the shape that produced it instead of argued about.
 */
export function catalogVariants(catalog: CatalogMeasurement): [string, number][] {
  const nilUuid = '00000000-0000-0000-0000-000000000000';
  const bound = buildProjectToolset(
    buildChatToolContext({ userId: nilUuid, projectId: nilUuid, projectSlug: 'measurement' }),
  ).tools;
  const unbound = buildProjectToolset({
    principal: {
      kind: 'pat',
      permissions: null,
      agency: 'agent',
      deviceId: null,
      userId: nilUuid,
      tokenId: 'measurement',
      scopes: ['read'],
      projectIds: [nilUuid],
    },
    projectSlug: 'measurement',
  } as Parameters<typeof buildProjectToolset>[0]).tools;
  return [
    ['wire, project-bound — what this module prices', catalog.chars],
    [
      'wire, unbound — projectId left in every schema',
      JSON.stringify(serializeCatalogForWire(unbound)).length,
    ],
    ['OpenAI-shaped toolset, project-bound', JSON.stringify(bound).length],
    [
      'wire, project-bound, pretty-printed at two spaces',
      JSON.stringify(catalog.wire, null, 2).length,
    ],
  ];
}

export type CountOutcome =
  | { ok: true; figure: TokenFigure }
  | { ok: false; reason: 'no-credential' | 'provider-refused' | 'unreadable' };

export interface CountOptions {
  apiKey?: string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

// cm:guard the base is `ANTHROPIC_API_URL` and never the vendor's own host — that variable is what points a deployment at a proxy (`config/env.ts`), so a hardcoded default would send this deployment's key to a host it was not issued for and count a path chat does not use (ISS-983)
async function countRequest(
  tools: unknown[] | undefined,
  apiKey: string,
  opts: CountOptions,
): Promise<number | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${openAiCompatUrl(opts.baseUrl ?? env.ANTHROPIC_API_URL, 'messages')}/count_tokens`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: PRICING.model,
      messages: [{ role: 'user', content: 'x' }],
      ...(tools ? { tools } : {}),
    }),
  });
  if (!res.ok) return null;
  let json: { input_tokens?: number };
  try {
    json = (await res.json()) as { input_tokens?: number };
  } catch {
    return null;
  }
  return typeof json.input_tokens === 'number' ? json.input_tokens : null;
}

// cm:guard `/v1/messages/count_tokens` prices the WHOLE request, framing and the carrier message included, so the catalog is the DIFFERENCE between two counts and never the count with tools in it — quoting the larger number attributes the request's own overhead to the prefix, which is the confusion this whole module exists to undo
export async function countCatalogTokens(
  wire: unknown[],
  opts: CountOptions = {},
): Promise<CountOutcome> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: 'no-credential' };
  let withTools: number | null;
  let withoutTools: number | null;
  try {
    withTools = await countRequest(wire, apiKey, opts);
    withoutTools = await countRequest(undefined, apiKey, opts);
  } catch {
    return { ok: false, reason: 'provider-refused' };
  }
  if (withTools === null || withoutTools === null) return { ok: false, reason: 'unreadable' };
  return { ok: true, figure: { tokens: withTools - withoutTools, provenance: 'measured' } };
}

function dollars(tokens: number, multiplier: number): number {
  return (tokens / 1_000_000) * PRICING.inputPerMTok * multiplier;
}

export interface CostCase {
  label: string;
  historyTokens: number;
  /** Dollars for the input side of one request, catalog included. */
  dollars: number;
}

/**
 * Three input-side prices for one request at a given history length: the catalog paid in full every
 * turn, the catalog written to a cache entry, and the catalog read back off a live one.
 */
export function costCases(catalogTokens: number, historyTokens: number): CostCase[] {
  const history = dollars(historyTokens, 1);
  return [
    {
      label: 'no cache — the catalog billed at full input rate every turn',
      historyTokens,
      dollars: history + dollars(catalogTokens, 1),
    },
    {
      label: 'cold — the catalog written to a 5-minute entry',
      historyTokens,
      dollars: history + dollars(catalogTokens, PRICING.cacheWriteMultiplier),
    },
    {
      label: 'warm — the catalog read off a live entry',
      historyTokens,
      dollars: history + dollars(catalogTokens, PRICING.cacheReadMultiplier),
    },
  ];
}

export interface DivergenceRow {
  historyTokens: number;
  promptTokens: number;
  cachedPromptTokens: number;
  /** What `chat_logs.usage` reports: an aggregate over the whole prompt. */
  aggregateRatio: number;
  /** What the catalog saved, in tokens — identical across the rows by construction. */
  prefixSavingTokens: number;
  prefixSavingDollars: number;
}

/**
 * The worked case the issue asks for: one cached catalog, two history lengths. The ratio
 * `chat_logs.usage` reports moves with the history; what the prefix saved does not.
 */
export function divergenceCase(catalogTokens: number, historyTokens: number[]): DivergenceRow[] {
  const savingTokens = catalogTokens * (1 - PRICING.cacheReadMultiplier);
  const savingDollars =
    dollars(catalogTokens, 1) - dollars(catalogTokens, PRICING.cacheReadMultiplier);
  return historyTokens.map((history) => ({
    historyTokens: history,
    promptTokens: catalogTokens + history,
    cachedPromptTokens: catalogTokens,
    aggregateRatio: catalogTokens / (catalogTokens + history),
    prefixSavingTokens: savingTokens,
    prefixSavingDollars: savingDollars,
  }));
}

export interface CensusRow {
  model: string | null;
  rows: number;
  withCachedField: number;
  firstAt: string | null;
  lastAt: string | null;
}

// cm:guard `chat_logs` records `model` and no provider column (`schema.ts:chatLogs`), so the census ISS-983 asked for — grouped by provider AND model — is not producible from this table, and the shortfall is printed rather than quietly narrowed; two backends reachable under one model name land in one row here
export const CENSUS_GROUPING_SHORTFALL =
  'chat_logs carries no provider column, only `model` — this census groups by model alone. Two backends reachable under one model name are indistinguishable in it.';

/**
 * How many logged chat requests came back reporting a cache read at all. `anthropic.ts:toUsage`
 * sets `cachedPromptTokens` only when the response carried `cache_read_input_tokens`, and
 * `openai.ts` only when it carried `prompt_tokens_details.cached_tokens`, so a backend that ignores
 * the markers leaves the field absent rather than zero.
 */
export async function runCensus(url: string): Promise<CensusRow[]> {
  const sql = postgres(url, { max: 1 });
  try {
    const rows = await sql<
      {
        model: string | null;
        rows: string;
        with_cached_field: string;
        first_at: Date | null;
        last_at: Date | null;
      }[]
    >`
      select model,
             count(*) as rows,
             count(*) filter (where usage ? 'cachedPromptTokens') as with_cached_field,
             min(created_at) as first_at,
             max(created_at) as last_at
      from chat_logs
      group by model
      order by count(*) desc
    `;
    return rows.map((r) => ({
      model: r.model,
      rows: Number(r.rows),
      withCachedField: Number(r.with_cached_field),
      firstAt: r.first_at ? r.first_at.toISOString() : null,
      lastAt: r.last_at ? r.last_at.toISOString() : null,
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const money = (d: number) => `$${d.toFixed(6)}`;
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
const count = (n: number) => n.toLocaleString('en-US');

function describe(f: TokenFigure): string {
  return f.provenance === 'measured' ? 'measured' : `estimated, chars/${f.divisor}`;
}

function printCatalog(catalog: CatalogMeasurement, tokens: TokenFigure, why: string | null): void {
  console.log('\n## Catalog, as the provider sees it');
  console.log(`tools: ${catalog.toolCount}`);
  console.log(`chars: ${count(catalog.chars)} (measured)`);
  console.log(`catalog: ${count(tokens.tokens)} tokens (${describe(tokens)})`);
  if (why) console.log(why);
  const side = tokens.tokens >= PRICING.minimumCacheablePrefixTokens ? 'above' : 'BELOW';
  console.log(
    `minimum cacheable prefix on ${PRICING.model}: ${PRICING.minimumCacheablePrefixTokens} tokens — the catalog is ${side} it`,
  );
  console.log('\nper tool, serialized:');
  for (const tool of catalog.wire as { name?: string }[]) {
    console.log(`  ${tool.name ?? '(unnamed)'}: ${count(JSON.stringify(tool).length)} chars`);
  }
}

/** Every serialization of the same nine tools, so a figure quoted elsewhere can be matched against the shape that produced it. */
function printVariants(catalog: CatalogMeasurement): void {
  console.log('\n## The same catalog, serialized four ways');
  for (const [label, chars] of catalogVariants(catalog)) {
    console.log(`  ${label}: ${count(chars)} chars`);
  }
}

function printCosts(catalogTokens: number, historyLengths: number[]): void {
  console.log('\n## Input-side cost of one request');
  console.log(
    `rates: input $${PRICING.inputPerMTok}/MTok, cache write x${PRICING.cacheWriteMultiplier}, cache read x${PRICING.cacheReadMultiplier} (${PRICING.provider} ${PRICING.model})`,
  );
  for (const history of historyLengths) {
    console.log(`\nuncached context: ${count(history)} tokens`);
    for (const c of costCases(catalogTokens, history)) {
      console.log(`  ${money(c.dollars)}  ${c.label}`);
    }
  }
  console.log('\n## One cached catalog, two history lengths');
  console.log(
    'the ratio chat_logs.usage reports moves; what the prefix saved does not. A report quoting that ratio has measured the history, not the catalog.',
  );
  for (const row of divergenceCase(catalogTokens, historyLengths)) {
    console.log(
      `  history ${count(row.historyTokens)}: promptTokens ${count(row.promptTokens)}, cachedPromptTokens ${count(row.cachedPromptTokens)}, ratio ${pct(row.aggregateRatio)}, prefix saving ${count(row.prefixSavingTokens)} tokens = ${money(row.prefixSavingDollars)}`,
    );
  }
}

// cm:guard the census prints FIRST and its failure never takes the rest of the run with it — whether anything caches is the question every figure below it is conditional on (ISS-983), and an optional refinement that aborts before the primary answer is how a run reports nothing at all
async function printCensus(url: string | undefined): Promise<boolean> {
  console.log('\n## Fleet cache census');
  if (!url) {
    console.log(
      'not answered: set FORGE_CENSUS_DATABASE_URL to the database holding chat_logs. No census is printed without one.',
    );
    return true;
  }
  console.log(CENSUS_GROUPING_SHORTFALL);
  let rows: CensusRow[];
  try {
    rows = await runCensus(url);
  } catch (err) {
    console.log(
      `not answered: the census query failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  if (rows.length === 0) console.log('chat_logs holds no rows.');
  for (const r of rows) {
    console.log(
      `  ${r.model ?? '(null)'}: ${r.rows} row(s), ${r.withCachedField} carrying usage.cachedPromptTokens, ${r.firstAt ?? '-'} .. ${r.lastAt ?? '-'}`,
    );
  }
  return true;
}

const COUNT_UNAVAILABLE: Record<Exclude<CountOutcome, { ok: true }>['reason'], string> = {
  'no-credential':
    'no ANTHROPIC_API_KEY, so /v1/messages/count_tokens was not called and the figure above is an estimate rather than a measurement.',
  'provider-refused':
    'ANTHROPIC_API_KEY is set but /v1/messages/count_tokens could not be reached, so the figure above is an estimate rather than a measurement.',
  unreadable:
    'ANTHROPIC_API_KEY is set and /v1/messages/count_tokens answered something this could not read, so the figure above is an estimate rather than a measurement.',
};

export async function main(): Promise<void> {
  console.log(`# Tool catalog cost — ${PRICING.provider} / ${PRICING.model}`);
  const censusAnswered = await printCensus(process.env.FORGE_CENSUS_DATABASE_URL);
  const catalog = measureLiveCatalog();
  const counted = await countCatalogTokens(catalog.wire);
  const tokens = counted.ok ? counted.figure : catalog.tokens;
  printCatalog(catalog, tokens, counted.ok ? null : COUNT_UNAVAILABLE[counted.reason]);
  printVariants(catalog);
  printCosts(tokens.tokens, [2_000, 20_000]);
  if (!censusAnswered) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
