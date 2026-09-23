import { describe, expect, it } from 'vitest';
import { recognisableIdentity, wholeIdentity } from '../messaging/verdict-identity.js';
import {
  type IssueIdentities,
  issueIdentities,
  standingSentence,
  type VerdictIdentity,
  verdictStanding,
} from './verdict-standing.js';

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const SOURCE = 'dce6f354c727baa81c681f144cbadf30050eabfc';
const OTHER = '1d1d63492f0ab8c5e5c3d1c6f6bb0b3b0c6a9f11';

const at = (kind: 'runtime' | 'source', value: string): VerdictIdentity => ({ kind, value });
const has = (serving: string | null, source: string | null): IssueIdentities => ({
  serving,
  source,
});

describe('issueIdentities', () => {
  it('reads the serving identity off the landing block and the source off the head', () => {
    expect(
      issueIdentities({ sessionContext: { landing: { deployment: SERVING, head: SOURCE } } }),
    ).toEqual({ serving: SERVING, source: SOURCE });
  });

  it('lets an observed merge outrank the head a run captured', () => {
    expect(
      issueIdentities({ sessionContext: { landing: { head: SOURCE } }, mergedCommitSha: OTHER }),
    ).toEqual({ serving: null, source: OTHER });
  });

  it('names nothing where the issue carries no landing block at all', () => {
    expect(issueIdentities({ sessionContext: null })).toEqual({ serving: null, source: null });
    expect(issueIdentities({ sessionContext: { landing: 'not a block' } })).toEqual({
      serving: null,
      source: null,
    });
  });
});

describe('verdictStanding', () => {
  it('stands where the runtime is the one the issue records as serving', () => {
    expect(verdictStanding(at('runtime', SERVING), has(SERVING, SOURCE))).toBe('stands');
  });

  it('is superseded where the runtime is not the one the issue records as serving', () => {
    expect(verdictStanding(at('runtime', OTHER), has(SERVING, SOURCE))).toBe('superseded');
  });

  it('is unwitnessed where the source still matches and no runtime was named', () => {
    expect(verdictStanding(at('source', SOURCE), has(null, SOURCE))).toBe('unwitnessed');
  });

  it('is superseded where the source is not the one the issue stands at', () => {
    expect(verdictStanding(at('source', OTHER), has(null, SOURCE))).toBe('superseded');
  });

  it('is unanchored where the verdict names nothing', () => {
    expect(verdictStanding(null, has(SERVING, SOURCE))).toBe('unanchored');
  });

  it('is unanchored where the issue names nothing, whatever the verdict cites', () => {
    expect(verdictStanding(at('runtime', SERVING), has(null, null))).toBe('unanchored');
    expect(verdictStanding(at('source', SOURCE), has(null, null))).toBe('unanchored');
  });

  it('does not let an abbreviation of the serving identity read as standing', () => {
    expect(verdictStanding(at('runtime', SERVING.slice(0, 7)), has(SERVING, null))).toBe(
      'superseded',
    );
  });

  it('matches a source abbreviated to seven characters, in either order and either case', () => {
    expect(verdictStanding(at('source', SOURCE.slice(0, 9)), has(null, SOURCE))).toBe(
      'unwitnessed',
    );
    expect(verdictStanding(at('source', SOURCE.toUpperCase()), has(null, SOURCE.slice(0, 9)))).toBe(
      'unwitnessed',
    );
  });

  it('matches nothing but its equal where the source is shorter than seven characters', () => {
    expect(verdictStanding(at('source', SOURCE.slice(0, 6)), has(null, SOURCE))).toBe('superseded');
    expect(verdictStanding(at('source', SOURCE.slice(0, 6)), has(null, SOURCE.slice(0, 6)))).toBe(
      'unwitnessed',
    );
  });

  it('is superseded where the verdict names a source and the issue names only a runtime', () => {
    expect(verdictStanding(at('source', SOURCE), has(SERVING, null))).toBe('superseded');
  });
});

describe('standingSentence', () => {
  it('names both identities when a verdict was superseded', () => {
    const line = standingSentence('superseded', at('runtime', OTHER), has(SERVING, SOURCE));
    expect(line).toContain(OTHER);
    expect(line).toContain(SERVING);
  });

  it('says a source identity cannot say the code was running', () => {
    expect(standingSentence('unwitnessed', at('source', SOURCE), has(null, SOURCE))).toContain(
      'never that the code was running',
    );
  });

  it('says an unanchored verdict named nothing to resolve', () => {
    expect(standingSentence('unanchored', null, has(null, null))).toContain(
      'without naming what it was judged against',
    );
  });
});

describe('recognisableIdentity', () => {
  it('takes seven hexadecimal characters, and more, ignoring surrounding whitespace', () => {
    expect(recognisableIdentity('dce6f35')).toBe(true);
    expect(recognisableIdentity(`  ${SOURCE}  `)).toBe(true);
    expect(recognisableIdentity('DCE6F35')).toBe(true);
  });

  it('refuses a blank value, six characters, and anything outside the hexadecimal alphabet', () => {
    expect(recognisableIdentity('')).toBe(false);
    expect(recognisableIdentity('   ')).toBe(false);
    expect(recognisableIdentity(null)).toBe(false);
    expect(recognisableIdentity('dce6f3')).toBe(false);
    expect(recognisableIdentity('0.17.1')).toBe(false);
    expect(recognisableIdentity('33637c61-2ef1-4be6-b924-520c0d201a08')).toBe(false);
  });
});

describe('wholeIdentity', () => {
  it('takes a whole object id and refuses an abbreviation of one', () => {
    expect(wholeIdentity(SOURCE)).toBe(true);
    expect(wholeIdentity(SOURCE.slice(0, 39))).toBe(false);
    expect(wholeIdentity('dce6f354c')).toBe(false);
  });
});
