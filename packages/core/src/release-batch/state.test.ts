import { describe, expect, it } from 'vitest';
import { recordedVerification } from './state.js';

const RUN = '22222222-2222-4222-8222-222222222222';

// ISS-1322, routed from ISS-1321's judge: an open batch with no probe showed `live: null` and
// nothing saying it would close unverified, because the state dropped what the run recorded.
describe('how a release run says its close is proved', () => {
  it('reads what the run recorded', () => {
    expect(recordedVerification({ verification: 'unverified' }, RUN)).toBe('unverified');
    expect(recordedVerification({ verification: 'probed' }, RUN)).toBe('probed');
  });

  it('reads null for a run that recorded none', () => {
    expect(recordedVerification({}, RUN)).toBeNull();
    expect(recordedVerification({ verification: null }, RUN)).toBeNull();
  });

  it('refuses a value that is neither, naming the run and the value', () => {
    expect(() => recordedVerification({ verification: 'maybe' }, RUN)).toThrow(
      new RegExp(`RELEASE_VERIFICATION_UNREADABLE.*${RUN}.*maybe`),
    );
  });
});
