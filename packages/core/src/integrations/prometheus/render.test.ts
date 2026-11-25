// ISS-1462: a probe's latency is a rule kind, `probe_slower_than`, and each wrong shape of it is
// refused by name.
import {
  monitoringConfigFaults,
  monitoringConfigSchema,
  type MonitoringConfig,
} from '@forge/contracts/monitoring';
import { describe, expect, it } from 'vitest';
import { renderRuleGroup } from './render.js';

const site = { name: 'site', url: 'https://www.example.test/' };
const slow = {
  name: 'site-slow',
  kind: 'probe_slower_than',
  target: 'site',
  threshold: 10,
  for: '2m',
  severity: 'high',
};

function parse(config: object): MonitoringConfig {
  const parsed = monitoringConfigSchema.safeParse(config);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return parsed.data as MonitoringConfig;
}

describe('probe_slower_than', () => {
  it('renders PromQL over probe_duration_seconds scoped to the project and its probe', () => {
    const config = parse({ probe: [site], rules: [slow] });
    expect(monitoringConfigFaults(config)).toEqual([]);
    const group = renderRuleGroup('acme', config);
    expect(group?.rules[0]?.expr).toBe(
      'probe_duration_seconds{forge_project="acme",forge_target="site"} > 10',
    );
  });

  it.each([
    ['no threshold', { ...slow, threshold: undefined }, 'SCHEMA_VIOLATION', '/rules/0/threshold'],
    ['a zero threshold', { ...slow, threshold: 0 }, 'SCHEMA_VIOLATION', '/rules/0/threshold'],
    ['a negative threshold', { ...slow, threshold: -3 }, 'SCHEMA_VIOLATION', '/rules/0/threshold'],
    ['a scrape target', { ...slow, target: 'api' }, 'MONITORING_RULE_TARGET_UNKNOWN', '/rules/0/target'],
    ['the agent target', { ...slow, target: 'agent' }, 'MONITORING_RULE_TARGET_UNKNOWN', '/rules/0/target'],
  ])('refuses %s by name', (_what, rule, code, path) => {
    const config = parse({
      scrape: [{ name: 'api', url: 'https://api.example.test/metrics' }],
      agent: { enabled: true },
      probe: [site],
      rules: [rule],
    });
    const faults = monitoringConfigFaults(config);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ code, path });
    expect(faults[0]?.detail).toContain('probe_slower_than');
  });

  it('a non-positive threshold says what is valid', () => {
    const config = parse({ probe: [site], rules: [{ ...slow, threshold: 0 }] });
    expect(monitoringConfigFaults(config)[0]?.detail).toContain('greater than 0');
  });

  it('series_above still refuses a probe target', () => {
    const config = parse({
      probe: [site],
      rules: [
        { name: 'q', kind: 'series_above', target: 'site', metric: 'probe_duration_seconds', threshold: 10, for: '2m', severity: 'low' },
      ],
    });
    expect(monitoringConfigFaults(config)).toMatchObject([
      { code: 'MONITORING_RULE_TARGET_UNKNOWN', path: '/rules/0/target' },
    ]);
  });
});
