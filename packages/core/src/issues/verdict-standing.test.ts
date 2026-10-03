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

/** The three shapes a reading comes back in, as `readServingNow` builds them. */
const serving = (commit: string): ServingReading => ({
  kind: 'serving',
  served: [{ commit: commit, where: HOST }],
  unread: [],
  readAt: READ_AT,
});
const disagreeing = (commits: string[]): ServingReading => ({
  kind: 'serving',
  served: commits.map((commit, i) => ({
    commit,
    where: i === 0 ? HOST : 'https://second.test/health',
  })),
  unread: [],
  readAt: READ_AT,
});
/** One probe answered, another gave nothing: an answer, not an absence. */
const partial = (commit: string): ServingReading => ({
  kind: 'serving',
  served: [{ commit: commit, where: HOST }],
  unread: ['https://second.test/health is unreachable (ECONNREFUSED)'],
  readAt: READ_AT,
});
const undeclared: ServingReading = {
  kind: 'undeclared',
  missing:
    'this project has no active deploy binding, so Forge makes no deployment it could read a commit from',
  route:
    'bind a deploy binding Forge deploys through whose provider reports the commit a deployment built (Coolify does), or declare `verify.probes` on the live deploy binding',
};
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

  // ISS-1286 F3 — one probe answering beside one that failed is a reading, never an absence.
  it('stands on the one commit a partly answering fleet reported', () => {
    expect(verdictStanding(at('runtime', SERVING), partial(SERVING), has(null))).toBe('stands');
  });

  it('is superseded, not uncorroborated, where a partly answering fleet reported another', () => {
    expect(verdictStanding(at('runtime', OTHER), partial(SERVING), has(null))).toBe('superseded');
  });

  it('resolves against the reading and never against what the issue stored', () => {
    // The sid-desk shape: the issue holds an ancestor, the host answers its descendant.
    const identities = issueIdentities({
      sessionContext: { landing: { head: SOURCE, deployment: OTHER } },
    });
    expect(verdictStanding(at('runtime', SERVING), serving(SERVING), identities)).toBe('stands');
  });
});

describe('verdictStanding — a source verdict with no reading of what is running', () => {
  it('is unwitnessed where the source still matches', () => {
    expect(verdictStanding(at('source', SOURCE), undeclared, has(SOURCE))).toBe('unwitnessed');
    expect(verdictStanding(at('source', SOURCE), unreadable('down'), has(SOURCE))).toBe(
      'unwitnessed',
    );
  });

  it('is superseded where the source is not the one the issue stands at', () => {
    expect(verdictStanding(at('source', OTHER), undeclared, has(SOURCE))).toBe('superseded');
  });

  it('is unanchored where the verdict names nothing', () => {
    expect(verdictStanding(null, serving(SERVING), has(SOURCE))).toBe('unanchored');
  });

  it('is unanchored where the issue stands at no source of its own', () => {
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
});

/** ISS-1346: a reading of what is running is Forge's observation, so it weighs either field. */
describe('verdictStanding — a source verdict under a reading of what is running', () => {
  it('stands where the reading names its commit, whatever source the issue stands at', () => {
    expect(verdictStanding(at('source', SERVING), serving(SERVING), has(SOURCE))).toBe('stands');
    expect(verdictStanding(at('source', SERVING), serving(SERVING), has(null))).toBe('stands');
  });

  it('is superseded where the reading names another commit, the issue source included', () => {
    expect(verdictStanding(at('source', SOURCE), serving(SERVING), has(SOURCE))).toBe('superseded');
    expect(verdictStanding(at('source', SOURCE), serving(SERVING), has(null))).toBe('superseded');
  });

  it('stands on a seven-character abbreviation of a commit the reading names, and not on six', () => {
    expect(verdictStanding(at('source', SERVING.slice(0, 7)), serving(SERVING), has(null))).toBe(
      'stands',
    );
    expect(verdictStanding(at('source', SERVING.slice(0, 6)), serving(SERVING), has(null))).toBe(
      'superseded',
    );
  });

  it('stands where any commit of a reading of two names it', () => {
    expect(verdictStanding(at('source', OTHER), disagreeing([SERVING, OTHER]), has(SOURCE))).toBe(
      'stands',
    );
  });

  // ISS-1346 criterion 25: what is served is the reading's, said once by the hold, never per verdict.
  it('names neither the issue source nor what is served when it does not stand', () => {
    const line = standingSentence(
      'superseded',
      at('source', SOURCE),
      serving(SERVING),
      has(SOURCE),
    );
    expect(line).toBe(`judged at ${SOURCE}, which is not a commit this project is serving`);
  });

  // ISS-1346 judge r2 finding 5: a 7-digit judged commit beside a 40-digit served one, compared by eye.
  it('says in words that the commit it was judged at is not one this project is serving', () => {
    const line = standingSentence(
      'superseded',
      at('source', 'dce6f35'),
      serving(SERVING),
      has(SOURCE),
    );
    expect(line).toContain('judged at dce6f35, which is not a commit this project is serving');
  });
});

describe('standingSentence', () => {
  it('names the runtime judged, and leaves the commit answered, the host and the moment to the hold', () => {
    const line = standingSentence(
      'superseded',
      at('runtime', OTHER),
      serving(SERVING),
      has(SOURCE),
    );
    expect(line).toContain(OTHER);
    expect(line).not.toContain(SERVING);
    expect(line).not.toContain(HOST);
    expect(line).not.toContain(READ_AT);
  });

  // ISS-1346 judge finding 2 — two commits answered is where each runs, never a fault.
  it('refuses a third commit beside a disagreeing fleet without calling the fleet a fault', () => {
    const line = standingSentence(
      'superseded',
      at('runtime', SOURCE),
      disagreeing([SERVING, OTHER]),
      has(null),
    );
    expect(line).toContain('which is not a commit this project is serving');
    expect(line).not.toContain('more than one commit is running');
  });

  it('stands on the probe that answered where another answered nothing', () => {
    expect(verdictStanding(at('runtime', SERVING), partial(SERVING), has(null))).toBe('stands');
    expect(verdictStanding(at('runtime', OTHER), partial(SERVING), has(null))).toBe('superseded');
  });

  it('says an uncorroborated verdict is weaker evidence and not a refusal', () => {
    const line = standingSentence('uncorroborated', at('runtime', SERVING), undeclared, has(null));
    expect(line).toContain('nothing here can read what this project is serving');
    expect(line).toContain(undeclared.kind === 'undeclared' ? undeclared.missing : '');
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

  it('says a verdict stands at what is served without restating the reading', () => {
    const line = standingSentence('stands', at('runtime', SERVING), serving(SERVING), has(null));
    expect(line).toBe(`judged at ${SERVING}, which this project is serving`);
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

// HOP ISS-1: a design verdict is weighed against the workflow's revision, never a serving reading.
describe('a design verdict', () => {
  const design = (value: string): VerdictIdentity => ({ kind: 'design', value });
  const designs = new Map([
    ['discharge-post-care', 4],
    ['b2eb2792-a043-4d5f-80a3-50a32c29e6e9', 4],
  ]);
  const held: IssueIdentities = { source: null, designs };

  it('stands on the revision the workflow is at now, by flow or by id, whatever is served', () => {
    for (const reading of [undeclared, serving(SERVING)]) {
      expect(verdictStanding(design('discharge-post-care rev 4'), reading, held)).toBe('stands');
      expect(
        verdictStanding(design('b2eb2792-a043-4d5f-80a3-50a32c29e6e9 rev 4'), reading, held),
      ).toBe('stands');
    }
  });

  it('is superseded by a later revision, and says which', () => {
    const stood = verdictStanding(design('discharge-post-care rev 2'), undeclared, held);
    expect(stood).toBe('superseded');
    expect(
      standingSentence(stood, design('discharge-post-care rev 2'), undeclared, held),
    ).toContain('now at revision 4');
  });

  it('anchors nothing where the project no longer holds the workflow, or the value is no design', () => {
    expect(verdictStanding(design('gone rev 1'), undeclared, held)).toBe('unanchored');
    expect(verdictStanding(design('discharge-post-care'), undeclared, held)).toBe('unanchored');
    expect(verdictStanding(design('discharge-post-care rev 4'), undeclared, has(null))).toBe(
      'unanchored',
    );
  });
});

describe('verdictStanding — a storefront draft (ISS-91)', () => {
  const draft = (note: string | null): VerdictIdentity => ({
    kind: 'storefront_draft',
    value: 'wf-1@draft:abc on `preview`',
    corroborationNote: note,
  });

  it('stands on the reading taken when it was recorded, whatever the production reading says', () => {
    expect(verdictStanding(draft(null), serving(OTHER), has(null))).toBe('stands');
    expect(standingSentence('stands', draft(null), undeclared, has(null))).toContain(
      'which the storefront source held',
    );
  });

  it('is uncorroborated where the source was not read back, and the sentence says why', () => {
    expect(verdictStanding(draft('http_502'), undeclared, has(null))).toBe('uncorroborated');
    expect(standingSentence('uncorroborated', draft('http_502'), undeclared, has(null))).toContain(
      'http_502',
    );
  });
});
