import { describe, expect, it } from 'vitest';
import { extractUsageFromEvents, type UsageEventRow } from './from-job-events.js';
import { estimateCost } from './pricing.js';

const TS = new Date('2026-06-10T12:00:00Z');

function stdout(line: unknown, ts = TS): UsageEventRow {
  return { kind: 'stdout', data: { line }, ts };
}

// Real claude stream-json shapes (snake_case usage on assistant + result lines;
// result also carries total_cost_usd / num_turns / modelUsage). Extra fields
// like nested cache_creation and usage.iterations are present on real lines —
// the extractor must read only the flat fields and ignore the rest.
function assistantLine(model: string, input: number, output: number) {
  return {
    type: 'assistant',
    message: {
      id: `msg_${model}_${input}`,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_1h: 0, ephemeral_5m: 50 },
      },
    },
  };
}

function resultLine(opts: {
  cost?: number;
  turns?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number }>;
}) {
  const line: Record<string, unknown> = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: opts.turns ?? 1,
    usage: {
      input_tokens: opts.input ?? 0,
      output_tokens: opts.output ?? 0,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation_input_tokens: opts.cacheCreation ?? 0,
      iterations: [{ foo: 'bar' }],
    },
  };
  if (opts.cost !== undefined) line.total_cost_usd = opts.cost;
  if (opts.modelUsage) line.modelUsage = opts.modelUsage;
  return line;
}

describe('extractUsageFromEvents', () => {
  it('extracts tokens from result.usage, cost from total_cost_usd, turns from num_turns', () => {
    const events = [
      stdout(assistantLine('claude-opus-4-8', 1000, 200)),
      stdout(
        resultLine({
          cost: 2.21614325,
          turns: 37,
          input: 1200,
          output: 240,
          cacheRead: 5000,
          cacheCreation: 800,
        }),
      ),
    ];
    const out = extractUsageFromEvents(events);
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      model: 'claude-opus-4-8',
      inputTokens: 1200,
      outputTokens: 240,
      cacheReadTokens: 5000,
      cacheCreationTokens: 800,
      requestCount: 37,
      estimatedCost: 2.21614325,
    });
    expect(out?.recordedAt).toEqual(TS);
  });

  it('prefers modelUsage dominant model over assistant lines', () => {
    const events = [
      stdout(assistantLine('claude-haiku-4-5', 50, 10)),
      stdout(
        resultLine({
          cost: 1,
          modelUsage: {
            'claude-haiku-4-5': { inputTokens: 50, outputTokens: 10 },
            'claude-opus-4-8': { inputTokens: 9000, outputTokens: 3000 },
          },
        }),
      ),
    ];
    expect(extractUsageFromEvents(events)?.model).toBe('claude-opus-4-8');
  });

  it('falls back to estimateCost when total_cost_usd is absent', () => {
    const events = [
      stdout(assistantLine('claude-sonnet-4', 10_000, 2_000)),
      stdout(resultLine({ input: 10_000, output: 2_000, cacheRead: 1_000, cacheCreation: 500 })),
    ];
    const out = extractUsageFromEvents(events);
    const expected = estimateCost('claude-sonnet-4', {
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 1_000,
      cacheCreationTokens: 500,
    });
    expect(expected).toBeGreaterThan(0);
    expect(out?.estimatedCost).toBe(expected);
  });

  it('returns null when there is no result line (job died pre-result)', () => {
    const events = [stdout(assistantLine('claude-opus-4-8', 100, 20))];
    expect(extractUsageFromEvents(events)).toBeNull();
  });

  it('returns null for a desktop job that streamed no stdout events', () => {
    const events: UsageEventRow[] = [
      { kind: 'progress', data: { claudeSessionId: 'abc' }, ts: TS },
    ];
    expect(extractUsageFromEvents(events)).toBeNull();
  });

  // cm:guard the two directions are asserted TOGETHER on one fixture because that is the whole rule: summing the cost would bill 6.5 for a session that cost 5.5, and taking the last usage would bill turn 2's tokens for a job that ran two turns. A test that checked only one of them passes on code that has the pair the wrong way round.
  it('sums the per-turn halves of a duplex session and takes cost from the last', () => {
    const later = new Date('2026-06-10T13:00:00Z');
    const events = [
      stdout(
        resultLine({
          cost: 1.0,
          turns: 4,
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheCreation: 31881,
        }),
        TS,
      ),
      stdout(
        resultLine({
          cost: 5.5,
          turns: 3,
          input: 999,
          output: 88,
          cacheRead: 31881,
          cacheCreation: 937,
        }),
        later,
      ),
    ];
    const out = extractUsageFromEvents(events);
    expect(out?.estimatedCost).toBe(5.5);
    expect(out?.inputTokens).toBe(1099);
    expect(out?.outputTokens).toBe(98);
    expect(out?.cacheReadTokens).toBe(31881);
    expect(out?.cacheCreationTokens).toBe(32818);
    expect(out?.requestCount).toBe(7);
    expect(out?.recordedAt).toEqual(later);
  });

  // cm:guard a print job must extract byte-identically before and after the sum — one result line makes summing and last-wins the same number, and this is the assertion that says so rather than leaving it to be inferred.
  it('is unchanged on a single-result print job', () => {
    const one = resultLine({
      cost: 2.0,
      turns: 9,
      input: 7,
      output: 5,
      cacheRead: 3,
      cacheCreation: 2,
    });
    const out = extractUsageFromEvents([stdout(one)]);
    expect(out).toMatchObject({
      inputTokens: 7,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
      requestCount: 9,
      estimatedCost: 2.0,
    });
  });

  it('estimates a costless duplex session from the SUMMED tokens', () => {
    const events = [
      stdout(
        resultLine({
          input: 100,
          output: 10,
          modelUsage: { m: { inputTokens: 1, outputTokens: 1 } },
        }),
      ),
      stdout(
        resultLine({
          input: 100,
          output: 10,
          modelUsage: { m: { inputTokens: 2, outputTokens: 2 } },
        }),
      ),
    ];
    const out = extractUsageFromEvents(events);
    expect(out?.estimatedCost).toBe(
      estimateCost('m', {
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    );
  });

  it('defaults requestCount to 1 and model to unknown when unavailable', () => {
    const out = extractUsageFromEvents([stdout(resultLine({ cost: 0.5 }))]);
    expect(out?.requestCount).toBe(1);
    expect(out?.model).toBe('unknown');
  });
});
