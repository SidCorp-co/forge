import { describe, it } from 'vitest';
import { clone, expectAccepted, expectRefused, read } from './schema.fixture.js';

const st = read('sim-forge-dev/state.dev.json');
const unknown = read('examples/preview.state.json');
const probe = st.probes[0];

describe('environment-state: an unknown state carries its reason', () => {
  it('accepts each cause', () => {
    for (const cause of ['external', 'no-record', 'adapter-error', 'binding-refused']) {
      expectAccepted('environment-state', { ...clone(unknown), reason: { cause, message: 'm' } });
    }
  });

  it('refuses an unknown state with no reason', () => {
    const { reason: _gone, ...bare } = clone(unknown);
    expectRefused('environment-state', bare, { path: '/reason' });
  });

  it('refuses a cause outside the four', () => {
    expectRefused(
      'environment-state',
      { ...clone(unknown), reason: { cause: 'timeout', message: 'm' } },
      { path: '/reason/cause', code: 'invalid_value' },
    );
  });

  it('refuses an unknown state claiming runtime evidence', () => {
    expectRefused(
      'environment-state',
      { ...clone(unknown), evidence: 'runtime-confirmed' },
      { path: '/evidence', code: 'invalid_value' },
    );
  });

  it('refuses a recorded state carrying a reason', () => {
    expectRefused(
      'environment-state',
      { ...clone(st), reason: { cause: 'external', message: 'm' } },
      { path: '', key: 'reason' },
    );
  });

  it('refuses a recorded state with no deployment', () => {
    const { deployment: _gone, ...bare } = clone(st);
    expectRefused('environment-state', bare, { path: '/deployment' });
  });
});

describe('environment-state: cancelled is its own state', () => {
  it('accepts state cancelled with a cancelled deployment', () => {
    const d = clone(st);
    d.state = 'cancelled';
    d.deployment.status = 'cancelled';
    expectAccepted('environment-state', d);
  });
});

describe('environment-state: each probe says what became of it', () => {
  it('accepts unreachable with its error', () => {
    const d = clone(st);
    d.evidence = 'runtime-unreachable';
    d.probes = [{ url: probe.url, identifies: 'source', status: 'unreachable', error: 'HTTP 503' }];
    expectAccepted('environment-state', d);
  });

  it('refuses unreachable with no error', () => {
    const d = clone(st);
    d.probes = [{ url: probe.url, identifies: 'source', status: 'unreachable' }];
    expectRefused('environment-state', d, { path: '/probes/0/error' });
  });

  it('refuses a mismatch that does not say what was expected', () => {
    const d = clone(st);
    d.probes = [{ url: probe.url, identifies: 'source', status: 'mismatch', observed: 'abc1234' }];
    expectRefused('environment-state', d, { path: '/probes/0/expected' });
  });

  it('refuses a probe status outside the four', () => {
    const d = clone(st);
    d.probes = [{ ...probe, status: 'skipped' }];
    expectRefused('environment-state', d, { path: '/probes/0/status' });
  });

  it('refuses an empty probes list, which would read as probed', () => {
    expectRefused('environment-state', { ...clone(st), probes: [] }, { path: '/probes' });
  });
});
