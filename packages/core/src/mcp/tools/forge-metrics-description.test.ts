/**
 * The `project_timeseries` description lists the metrics the tool serves (ISS-1132). It once named
 * six of the eight, so a caller reading it never learned `queue_depth` or `runner_uptime` existed.
 * The list now comes from `METRICS`, and this test is what goes red if it stops doing so.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    APP_BASE_URL: 'https://forge.test',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const { METRICS } = await import('../../metrics/queries.js');
const { forgeMetricsProjectTimeseriesTool } = await import('./forge-metrics.js');

const tool = forgeMetricsProjectTimeseriesTool({ principal: { userId: 'u1' } } as never);

/** The names the description offers for `metric`, read from the sentence a caller reads. */
function listedMetrics(description: string): string[] {
  const m = /one `metric` of ([^,]+), derived/.exec(description);
  if (!m?.[1])
    throw new Error('the description no longer states the metric list in its usual place');
  return m[1].split(' | ');
}

describe('forge_metrics.project_timeseries description', () => {
  it('lists exactly the metrics the registry serves, in order', () => {
    expect(listedMetrics(tool.description)).toEqual([...METRICS]);
  });

  it('names every metric the input schema accepts, so none is served unannounced', () => {
    const accepted = (tool.inputSchema as { properties: { metric: { enum: string[] } } }).properties
      .metric.enum;
    expect(accepted.length).toBeGreaterThan(0);
    for (const name of accepted) expect(tool.description).toContain(name);
  });

  it('names no retired metric as served', () => {
    expect(listedMetrics(tool.description)).not.toContain('pass_rate');
    expect(listedMetrics(tool.description)).not.toContain('approve_rate');
  });
});
