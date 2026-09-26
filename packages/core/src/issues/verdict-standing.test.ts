import { describe, expect, it } from 'vitest';
import { recognisableIdentity, wholeIdentity } from '../messaging/verdict-identity.js';
import type { ServingReading } from '../release-batch/serving-reading.js';
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
const READ_AT = '2026-09-26T23:55:00.000Z';
const HOST = 'https://helpdesk-api.musetools.com/api/build-info';

const at = (kind: 'runtime' | 'source', value: string): VerdictIdentity => ({ kind, value });
const has = (source: string | null): IssueIdentities => ({ source });

/** The four shapes a reading comes back in, as `readServingNow` builds them. */
const serving = (commit: string): ServingReading => ({
  kind: 'serving',
  commit,
  hosts: [HOST],
  readAt: READ_AT,
});
const disagreeing = (commits: string[]): ServingReading => ({
  kind: 'disagreeing',
  commits,
  hosts: [HOST, 'https://second.test/health'],
  readAt: READ_AT,
});
const undeclared: ServingReading = { kind: 'undeclared' };
const unreadable = (why: string): ServingReading => ({
  kind: 'unreadable',
  why,
  hosts: [HOST],
  readAt: READ_AT,
});

describe('issueIdentities', () => {
  it('reads the source off the landing head', () => {
    expect(issueIdentities({ sessionContext: { landing: { head: SOURCE } } })).toEqual({
      source: SOURCE,
    });
  });

  it('lets an observed merge outrank the head a run captured', () => {
    expect(
      issueIdentities({ sessionContext: { landing: { head: SOURCE } }, mergedCommitSha: OTHER }),
    ).toEqual({ source: OTHER });
  });

  it('names nothing where the issue carries no landing block at all', () => {
    expect(issueIdentities({ sessionContext: null })).toEqual({ source: null });
    expect(issueIdentities({ sessionContext: { landing: 'not a block' } })).toEqual({
      source: null,
    });
  });

  // ISS-1286 — landing.deployment reaches no identity, whatever a caller wrote there.
  it('reads nothing out of landing.deployment, whatever it holds', () => {
    const row = { sessionContext: { landing: { head: SOURCE, deployment: OTHER } } };
    expect(issueIdentities(row)).toEqual({ source: SOURCE });
    expect(JSON.stringify(issueIdentities(row))).not.toContain(OTHER);
  });
});

describe('verdictStanding — a runtime verdict against a reading (ISS-1286)', () => {
  it('stands where the runtime is what the reading says is serving', () => {
    expect(verdictStanding(at('runtime', SERVING), serving(SERVING), has(SOURCE))).toBe('stands');
  });

  it('is superseded where the runtime is not what the reading says is serving', () => {
    expect(verdictStanding(at('runtime', OTHER), serving(SERVING), has(SOURCE))).toBe('superseded');
  });

  it('does not let an abbreviation of the serving identity read as standing', () => {
    expect(verdictStanding(at('runtime', SERVING.slice(0, 7)), serving(SERVING), has(null))).toBe(
      'superseded',
    );
  });

  it('is uncorroborated where the project declares no way to ask', () => {
    expect(verdictStanding(at('runtime', SERVING), undeclared, has(SOURCE))).toBe('uncorroborated');
  });

  it('is uncorroborated where what is declared could not be read', () => {
    expect(verdictStanding(at('runtime', SERVING), unreadable('host is down'), has(SOURCE))).toBe(
      'uncorroborated',
    );
  });

  it('stands on one of the commits a disagreeing fleet answered', () => {
    expect(verdictStanding(at('runtime', OTHER), disagreeing([SERVING, OTHER]), has(null))).toBe(
      'stands',
    );
  });

  it('is superseded where a disagreeing fleet answered neither of them', () => {
    expect(verdictStanding(at('runtime', SOURCE), disagreeing([SERVING, OTHER]), has(null))).toBe(
      'superseded',
    );
  });

  it('resolves against the reading and never against what the issue stored', () => {
    // The sid-desk shape: the issue holds an ancestor, the host answers its descendant.
    const identities = issueIdentities({
      sessionContext: { landing: { head: SOURCE, deployment: OTHER } },
    });
    expect(verdictStanding(at('runtime', SERVING), serving(SERVING), identities)).toBe('stands');
  });
});

describe('verdictStanding — a source verdict, unchanged', () => {
  it('is unwitnessed where the source still matches and no runtime was named', () => {
    expect(verdictStanding(at('source', SOURCE), serving(SERVING), has(SOURCE))).toBe(
      'unwitnessed',
    );
  });

  it('is superseded where the source is not the one the issue stands at', () => {
    expect(verdictStanding(at('source', OTHER), serving(SERVING), has(SOURCE))).toBe('superseded');
  });

  it('is unanchored where the verdict names nothing', () => {
    expect(verdictStanding(null, serving(SERVING), has(SOURCE))).toBe('unanchored');
  });

  it('is unanchored where the issue stands at no source of its own', () => {
    expect(verdictStanding(at('source', SOURCE), serving(SERVING), has(null))).toBe('unanchored');
    expect(verdictStanding(at('source', SOURCE), undeclared, has(null))).toBe('unanchored');
  });

  it('matches a source abbreviated to seven characters, in either order and either case', () => {
    expect(verdictStanding(at('source', SOURCE.slice(0, 9)), undeclared, has(SOURCE))).toBe(
      'unwitnessed',
    );
    expect(
      verdictStanding(at('source', SOURCE.toUpperCase()), undeclared, has(SOURCE.slice(0, 9))),
    ).toBe('unwitnessed');
  });

  it('matches nothing but its equal where the source is shorter than seven characters', () => {
    expect(verdictStanding(at('source', SOURCE.slice(0, 6)), undeclared, has(SOURCE))).toBe(
      'superseded',
    );
    expect(
      verdictStanding(at('source', SOURCE.slice(0, 6)), undeclared, has(SOURCE.slice(0, 6))),
    ).toBe('unwitnessed');
  });

  it('is decided by the issue source whatever the reading says', () => {
    expect(verdictStanding(at('source', SOURCE), serving(SOURCE), has(OTHER))).toBe('superseded');
  });
});

describe('standingSentence', () => {
  it('names the runtime judged, the commit answered, the host asked and the moment', () => {
    const line = standingSentence(
      'superseded',
      at('runtime', OTHER),
      serving(SERVING),
      has(SOURCE),
    );
    expect(line).toContain(OTHER);
    expect(line).toContain(SERVING);
    expect(line).toContain(HOST);
    expect(line).toContain(READ_AT);
  });

  it('names both commits a disagreeing fleet answered when it refuses a third', () => {
    const line = standingSentence(
      'superseded',
      at('runtime', SOURCE),
      disagreeing([SERVING, OTHER]),
      has(null),
    );
    expect(line).toContain(SERVING);
    expect(line).toContain(OTHER);
    expect(line).toContain('a rollout that has not finished');
  });

  it('says an uncorroborated verdict is weaker evidence and not a refusal', () => {
    const line = standingSentence('uncorroborated', at('runtime', SERVING), undeclared, has(null));
    expect(line).toContain('declares no way to ask');
    expect(line).toContain('it is not a refusal');
    expect(line).not.toContain(READ_AT);
  });

  it('says why nothing could be read, and when it was asked', () => {
    const line = standingSentence(
      'uncorroborated',
      at('runtime', SERVING),
      unreadable('https://x.test/h is unreachable (getaddrinfo ENOTFOUND)'),
      has(null),
    );
    expect(line).toContain('getaddrinfo ENOTFOUND');
    expect(line).toContain(READ_AT);
    expect(line).toContain('it is not a refusal');
  });

  it('names the host and the moment when a verdict stands', () => {
    const line = standingSentence('stands', at('runtime', SERVING), serving(SERVING), has(null));
    expect(line).toContain(HOST);
    expect(line).toContain(READ_AT);
  });

  it('says a source identity cannot say the code was running', () => {
    expect(
      standingSentence('unwitnessed', at('source', SOURCE), undeclared, has(SOURCE)),
    ).toContain('never that the code was running');
  });

  it('names the source a superseded source verdict no longer stands at', () => {
    const line = standingSentence('superseded', at('source', OTHER), undeclared, has(SOURCE));
    expect(line).toContain(`this issue now stands at ${SOURCE}`);
  });

  it('says an unanchored verdict named nothing to resolve', () => {
    expect(standingSentence('unanchored', null, undeclared, has(null))).toContain(
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
