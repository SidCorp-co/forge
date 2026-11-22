import { describe, expect, it } from 'vitest';
import { type Judged, judgedOnSaid } from './judged-environment.js';

const judged = (environment: string, namedBy: string): Judged => ({
  ok: true,
  environment,
  testing: 'qa',
  basis: 'landing',
  namedBy,
});

describe('judgedOnSaid (TESTING_ENVIRONMENT_NOT_JUDGED)', () => {
  const landed = judged('dev', 'its merge-mark target `dev`');

  it('names the landing alone where no release carried the issue', () => {
    expect(judgedOnSaid(null, landed)).toEqual({
      said: '`dev` (named by its merge-mark target `dev`)',
      judged: ['dev'],
    });
  });

  it('names one environment once where the release and the landing agree', () => {
    const released = judged('dev', 'release 0.4.0-dev.788');
    expect(judgedOnSaid(released, landed)).toEqual({
      said: '`dev` (named by release 0.4.0-dev.788 and by its merge-mark target `dev`)',
      judged: ['dev'],
    });
  });

  it('offers both where they differ', () => {
    const released = judged('live', 'release 0.4.0-dev.788');
    expect(judgedOnSaid(released, landed)).toEqual({
      said: '`live` (named by release 0.4.0-dev.788) or `dev` (named by its merge-mark target `dev`)',
      judged: ['live', 'dev'],
    });
  });
});
