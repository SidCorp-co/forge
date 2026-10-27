import { describe, expect, it } from 'vitest';
import { ApiError, unsaidFailure } from './client';
import {
  describeSettings,
  formatApiError,
  formatApiReason,
  formatEnvironmentsWriteError,
  formatPipelineConfigError,
  formatSettingsWriteError,
  isRetryableApiError,
  readFailure,
} from './error';

describe('formatPipelineConfigError', () => {
  it('names the offending stage for MISSING_SKILL_FOR_ENABLED_STAGE', () => {
    const err = new ApiError(
      409,
      'enabled auto-stage toggles require a registered skill for the corresponding stage',
      'MISSING_SKILL_FOR_ENABLED_STAGE',
      { stagesMissingSkill: ['open'] },
    );
    const msg = formatPipelineConfigError(err);
    expect(msg).toContain('Open needs a registered skill');
    expect(msg).toMatch(/register a skill/i);
    expect(msg).toMatch(/automatic running off/i);
    expect(msg).not.toMatch(/toggle|Auto /i);
  });

  it('handles AUTO_STAGE_NEEDS_SKILL the same way', () => {
    const err = new ApiError(409, 'auto-mode stages require a registered skill', 'AUTO_STAGE_NEEDS_SKILL', {
      stagesMissingSkill: ['developed'],
    });
    const msg = formatPipelineConfigError(err);
    expect(msg).toContain('Developed');
  });

  it('names multiple missing-skill stages', () => {
    const err = new ApiError(409, 'x', 'MISSING_SKILL_FOR_ENABLED_STAGE', {
      stagesMissingSkill: ['open', 'testing'],
    });
    const msg = formatPipelineConfigError(err);
    expect(msg).toContain('Open, Testing');
  });

  it('reports blocking issue count for STAGE_HAS_ISSUES', () => {
    const err = new ApiError(409, 'cannot disable stages while issues are at those stages', 'STAGE_HAS_ISSUES', {
      stagesBlocked: ['developed'],
      blockingIssueIds: ['x', 'y'],
    });
    const msg = formatPipelineConfigError(err);
    expect(msg).toContain('Can\'t disable Developed');
    expect(msg).toContain('2');
    expect(msg).toMatch(/move or close/i);
  });

  it('lists unreachable stages for DEAD_END_CONFIG', () => {
    const err = new ApiError(400, 'Cannot disable stages with no forward path: testing', 'DEAD_END_CONFIG', {
      unreachable: ['testing'],
    });
    const msg = formatPipelineConfigError(err);
    expect(msg).toContain('Testing');
    expect(msg).toMatch(/no forward path/i);
  });

  it('explains OPEN_LOCKED_ON', () => {
    const err = new ApiError(400, 'open stage cannot be disabled', 'OPEN_LOCKED_ON');
    expect(formatPipelineConfigError(err)).toMatch(/Open stage can't be disabled/i);
  });

  it('names a stage by the status vocabulary, and keeps the raw name of one it does not hold', () => {
    const err = new ApiError(409, 'x', 'STAGE_HAS_ISSUES', {
      stagesBlocked: ['waiting', 'not_a_status'],
      blockingIssueIds: ['a'],
    });
    expect(formatPipelineConfigError(err)).toContain('Waiting, not_a_status');
  });

  it('falls back to formatApiError when details is missing/odd', () => {
    const err = new ApiError(409, 'enabled auto-stage toggles require a registered skill', 'MISSING_SKILL_FOR_ENABLED_STAGE');
    // No usable details → identical to the generic formatter (the raw message).
    expect(formatPipelineConfigError(err)).toBe(formatApiError(err));
  });

  it('falls back to formatApiError for non-pipeline ApiError codes', () => {
    const err = new ApiError(403, 'nope', 'FORBIDDEN');
    expect(formatPipelineConfigError(err)).toBe(formatApiError(err));
  });

  it('falls back to formatApiError for a generic Error', () => {
    const err = new Error('boom');
    expect(formatPipelineConfigError(err)).toBe(formatApiError(err));
  });
});

/**
 * ISS-1160 — no screen offers Retry on a refusal that retrying cannot change.
 * A 4xx is the same request meeting the same answer again; only a 5xx or a
 * transport failure (not an ApiError at all) is worth resubmitting.
 */
describe('isRetryableApiError', () => {
  it('refuses retry on a 400 — the malformed-identifier / missing-scope refusal', () => {
    expect(isRetryableApiError(new ApiError(400, 'Invalid input', 'BAD_REQUEST'))).toBe(false);
  });

  it('refuses retry on a 404 — the key-names-nothing refusal', () => {
    expect(isRetryableApiError(new ApiError(404, 'not found', 'NOT_FOUND'))).toBe(false);
  });

  it('refuses retry on a 403 — the project-the-caller-cannot-read refusal', () => {
    expect(isRetryableApiError(new ApiError(403, 'nope', 'FORBIDDEN'))).toBe(false);
  });

  it('allows retry on a 500 — a server fault the same request might not repeat', () => {
    expect(isRetryableApiError(new ApiError(500, 'boom', 'INTERNAL_ERROR'))).toBe(true);
  });

  it('allows retry on a non-ApiError — a transport failure, not a refusal', () => {
    expect(isRetryableApiError(new Error('fetch failed'))).toBe(true);
  });
});

// ISS-1327 — core's merge-mark refusals are written for agents and name every door; a person on the
// web has one, the issue's Mark merged control, and the toast that carries the sentence is short.
describe('formatApiError — the merge-mark refusals, in the web\'s words', () => {
  const words = (s: string) => s.trim().split(/\s+/).length;

  // ISS-1421 r16: core words the unshipped close for a person and an agent alike, in the page's own
  // control names, so the web shows it as sent rather than keeping a second wording beside it.
  it('shows the unshipped close as core says it', () => {
    const said =
      "This issue can't close yet: it is not marked merged. Use Mark merged in the issue's properties, then close it. If it turned out not to be work, move it to Dropped instead.";
    const msg = formatApiError(new ApiError(422, said, 'CLOSE_REQUIRES_SHIPPED', { requires: 'mergedAt' }));
    expect(msg).toBe(said);
    for (const sentence of msg.split(/(?<=\.) /)) expect(words(sentence)).toBeLessThanOrEqual(20);
  });

  it('names the panel field, never the REST one, for a mark naming no landing (ISS-1421 r9)', () => {
    const msg = formatApiError(new ApiError(422, 'Send `landing` naming the live URL.', 'LANDING_REQUIRED'));
    expect(msg).toBe(
      'Nothing was marked, because no merged pull request shows where this work landed. Fill in “Where it landed” with the live URL, CMS entry or storefront resource.',
    );
    expect(msg).not.toContain('`');
  });

  it('names the landing that stands, and Unmark, for a refused correction', () => {
    const msg = formatApiError(
      new ApiError(422, 'core sentence', 'MARK_ALREADY_STANDS', { heldLanding: 'https://shop.example.com/a' }),
    );
    expect(msg).toContain('https://shop.example.com/a');
    expect(msg).toContain('press Unmark');
    expect(msg).toContain('nothing changed');
    // ISS-1421 r10: the sentences a mark is answered in carry no dash (criterion 63).
    expect(msg).not.toContain('—');
  });
});

// ISS-1381 r4 — core's CLAIM_CONFLICT sentence names the API routes an agent reads a run by; a
// person pressing Release now has none of them, so the page says each standing in its own words.
describe('formatApiError — CLAIM_CONFLICT', () => {
  const conflict = (conflicts: unknown[]) =>
    new ApiError(
      409,
      '1 issue named here cannot be claimed for a release. ISS-11 is claimed by release batch r-1, which is still running: read where it stands with GET /api/projects/p/release-batches/r-1/state.',
      'CLAIM_CONFLICT',
      { issueIds: ['i-1'], conflicts, projectId: 'p', gateStatus: 'awaiting_release' },
    );

  it('says an issue is already in a running release, and names no route', () => {
    const msg = formatApiError(
      conflict([
        { id: 'i-1', key: 'ISS-11', standing: 'claimed', runId: 'r-1', runEnded: false, claimer: 'batch', status: 'awaiting_release' },
      ]),
    );
    expect(msg).toContain('ISS-11 is already in a release that is still running');
    expect(msg).not.toMatch(/\/api\/|GET |POST /);
  });

  it('names each standing a refusal carries: an ended claim, a status, an absent issue', () => {
    const msg = formatApiError(
      conflict([
        { id: 'i-1', key: 'ISS-1', standing: 'claimed', runId: 'r-2', runEnded: true, claimer: 'batch', status: 'releasing' },
        { id: 'i-2', key: 'ISS-2', standing: 'claimed', runId: 'r-2', runEnded: true, claimer: 'batch', status: 'awaiting_release' },
        { id: 'i-3', key: 'ISS-3', standing: 'status', status: 'closed' },
        { id: 'i-4', key: 'ISS-4', standing: 'status', status: 'in_progress' },
        { id: 'x', key: 'x', standing: 'absent' },
      ]),
    );
    expect(msg).toContain('ISS-1 is still held by a release that has ended');
    expect(msg).toContain('ISS-2 is still marked as in a release that has ended');
    expect(msg).toContain('ISS-3 is Closed');
    expect(msg).toContain('ISS-4 is In progress, not at the release gate');
    expect(msg).toContain('x is no issue on this project');
    expect(msg).not.toMatch(/\/api\/|GET |POST /);
  });

  it('keeps the server sentence where the refusal carries no standings to compose from', () => {
    const err = new ApiError(409, 'Nothing here can be claimed.', 'CLAIM_CONFLICT', { issueIds: ['i-1'] });
    expect(formatApiError(err)).toBe('Nothing here can be claimed.');
  });
});

describe('the connection refusals (ISS-1216)', () => {
  // A 404 under `NOT_FOUND` prints "Not found." and drops the server's sentence, which is what the
  // connection drawer's red panel showed; these two codes are what keeps the sentence.
  const reachable =
    "This connection is not one you can reach. A connection is visible to the individual who owns it, to the members of the organization that owns it, and to an admin of a project it is shared with. Only its owner (for an organization's connection, an owner or admin of that organization) can share it with a project you administer, so ask them.";

  it('prints the server sentence for a connection the caller cannot reach, not "Not found."', () => {
    const err = new ApiError(404, reachable, 'CONNECTION_NOT_REACHABLE');
    expect(formatApiError(err)).toBe(reachable);
  });

  it('prints the server sentence for a connection the caller may read but not change', () => {
    const sentence = 'You can see the connection "Deploy box" but not test it: it is owned by a member who has set no name Forge can show, and only its owner can test it. Ask the member who owns it, or create a connection of your own.';
    const err = new ApiError(403, sentence, 'CONNECTION_NOT_MANAGEABLE');
    expect(formatApiError(err)).toBe(sentence);
  });

  // Round 24 (the master's ruling): the server's own sentence wins over the stock one for every code.
  it("prints a plain NOT_FOUND's own sentence, and the generic phrase only where it said none", () => {
    expect(formatApiError(new ApiError(404, 'Project not found.', 'NOT_FOUND'))).toBe('Project not found.');
    expect(formatApiError(new ApiError(404, 'Not Found', 'NOT_FOUND'))).toBe('Not found.');
  });
});

describe('a refusal because the document moved', () => {
  const stale = (...paths: string[]) =>
    new ApiError(409, 'stale', 'CONFIG_STALE', { conflicts: paths.map((path) => ({ path, base: 1, stored: 2 })) });

  it('agrees with one setting that moved', () => {
    expect(formatSettingsWriteError(stale('plugins'))).toMatch(/^Plugins was changed by someone else/);
  });

  it('names the fields when two paths of one section moved, and says were', () => {
    const msg = formatSettingsWriteError(
      stale('knowledgePromotion.minRetrievals', 'knowledgePromotion.candidatesPerRun'),
    );
    expect(msg).toMatch(
      /^Knowledge promotion \(Proposals per night and Minimum retrievals\) were changed by someone else/,
    );
  });

  it('says were for settings in two sections', () => {
    expect(formatSettingsWriteError(stale('plugins', 'intakeGate.notify'))).toMatch(
      /^Intake gate \(Notify the owner\) and Plugins were changed/,
    );
  });
});

describe('describeSettings', () => {
  it('counts the settings named, not the paths sent', () => {
    expect(describeSettings(['plugins', 'plugins']).count).toBe(1);
  });

  it('names each stage setting once: a runner pool has its own section, a permission its field', () => {
    expect(describeSettings(['states.open.deviceIds']).text).toBe('Runner pools (Open)');
    expect(describeSettings(['states.open.disallowedTools']).text).toBe('Stage permissions (Open) (Denied tools)');
    expect(describeSettings(['states.open.mcpServers.playwright']).text).toBe(
      'Stage permissions (Open) (MCP server playwright)',
    );
  });

  it('keeps a stage setting in the stage it belongs to', () => {
    expect(describeSettings(['states.open.deviceIds']).text).toBe('Runner pools (Open)');
  });

  it("names the entry stage's switch as the Pipeline page does, with no stage after it", () => {
    expect(describeSettings(['states.open.mode']).text).toBe('Start queued issues automatically');
    expect(describeSettings(['states.open.enabled', 'states.open.mode'])).toEqual({
      text: 'Start queued issues automatically',
      count: 1,
    });
  });
});

describe('a server error that carries only its HTTP status text', () => {
  it('is said as a failed request in words, with no status code', () => {
    expect(formatApiError(new ApiError(500, 'Internal Server Error'))).toBe(
      'The server ran into a problem and could not finish the request.',
    );
    expect(formatApiError(new ApiError(503, 'Service Unavailable'))).toBe(
      'The server is unavailable right now. Try again in a moment.',
    );
    expect(formatApiError(new ApiError(504, 'Gateway Timeout'))).toBe(
      'The server did not answer in time. Try again in a moment.',
    );
  });

  it('covers every standard 5xx status text, whole-message only', () => {
    expect(formatApiError(new ApiError(501, 'Not Implemented'))).toBe(
      'The server ran into a problem and could not finish the request.',
    );
    expect(formatApiError(new ApiError(505, 'HTTP Version Not Supported'))).toBe(
      'The server ran into a problem and could not finish the request.',
    );
    expect(formatApiError(new ApiError(501, 'Not Implemented for this provider'))).toBe(
      'Not Implemented for this provider',
    );
  });

  it('opens a reason as a sentence of its own, and ends it', () => {
    expect(formatApiReason(new ApiError(503, 'the plugins store is down'))).toBe('The plugins store is down.');
    expect(formatApiReason(new ApiError(500, 'Internal Server Error'))).toBe(
      'The server ran into a problem and could not finish the request.',
    );
  });

  it('never prints a bare number, for a failure that carries no message at all', () => {
    expect(formatApiError(new ApiError(500, ''))).not.toMatch(/\d{3}/);
    expect(formatApiError(new ApiError(422, ''))).not.toMatch(/\d{3}/);
  });
});

describe('formatEnvironmentsWriteError (ISS-1171 r6)', () => {
  const invalid = (conflicts: unknown[]) =>
    new ApiError(400, "testCredentials[1] ('Admin') has no password.", 'ENVIRONMENTS_INVALID', { conflicts });

  it('names each credential rule by the row the page shows, never the document path', () => {
    const err = invalid([
      { path: 'testCredentials.1.label', rule: 'duplicate-label', sameAs: 0 },
      { path: 'testCredentials.2.username', rule: 'duplicate-login', sameAs: 0 },
    ]);
    const said = formatEnvironmentsWriteError(err, ['QA', 'qa', 'Owner']);
    expect(said).toBe(
      'Two credentials are labelled qa. Rename one of them, or remove it. Owner is the same login as QA. Remove one of them.',
    );
    expect(said).not.toMatch(/testCredentials|\[\d\]/);
  });

  it('names every row one way, by its label, and by its number only where the page holds none', () => {
    const said = formatEnvironmentsWriteError(
      invalid([
        { path: 'testCredentials.1.password', rule: 'password-required' },
        { path: 'testCredentials.2.username', rule: 'duplicate-login', sameAs: 1 },
        { path: 'testCredentials.3.label', rule: 'duplicate-label' },
      ]),
      ['QA one', '', 'QA two'],
    );
    expect(said).toBe(
      'Credential 2 has no password. Type its password, or remove the row. QA two is the same login as Credential 2. Remove one of them. Credential 4 has a label another credential already has. Rename one of them, or remove it.',
    );
    expect(said).not.toMatch(/Test credential|\(\w/);
  });

  it('names a setting the server refused for its own schema by its screen name', () => {
    expect(formatEnvironmentsWriteError(invalid([{ path: 'live.url', message: 'Invalid url' }]))).toBe(
      'Live (URL) is not a value this page can store. Correct it, then save again.',
    );
  });

  it('says a server failure as what happened and what to do, whatever its message', () => {
    const said = formatEnvironmentsWriteError(new ApiError(503, 'Planted: pool exhausted', 'SERVER_ERROR'));
    expect(said).toBe('The server is unavailable right now. Try again in a moment. Your edits are still here.');
  });
});

describe('readFailure — a failed read in the product\'s words, and the server\'s own beside it', () => {
  it('says a server failure that gave no reason by its status and keeps the code and message for the technical view', () => {
    expect(readFailure(new ApiError(500, 'Internal Server Error', 'INTERNAL_ERROR'))).toEqual({
      said: 'The server ran into a problem and could not finish the request.',
      technical: '500 INTERNAL_ERROR — Internal Server Error',
    });
  });

  // Round 23 (judge-74, criterion 226): the Pipeline page answered this 409 with "Something changed
  // since this page loaded. Reload it, then try again." while the issue page gave core's sentence.
  it("gives a refusal's own sentence, as every other failure line does", () => {
    const refusal = 'The holds could not be read while a migration holds the table. Try again in a minute.';
    const err = new ApiError(409, refusal, 'HOLDS_READ_REFUSED');
    expect(readFailure(err)).toEqual({ said: refusal, technical: `409 HOLDS_READ_REFUSED — ${refusal}` });
    expect(readFailure(err).said).toBe(formatApiError(err));
  });

  // Round 24 (judge-78, criterion 226): beta refused a non-member with "Not a project member." and the
  // page said "You do not have access to this resource." over it.
  it("says a refusal by the server's own sentence, over the stock one its code has", () => {
    expect(readFailure(new ApiError(403, 'Not a project member.', 'FORBIDDEN'))).toEqual({
      said: 'Not a project member.',
      technical: '403 FORBIDDEN — Not a project member.',
    });
  });

  it('says the stock sentence only for a refusal that said nothing of its own', () => {
    expect(readFailure(new ApiError(403, 'Forbidden', 'FORBIDDEN')).said).toBe('You do not have access to this resource.');
    expect(readFailure(new ApiError(403, unsaidFailure(403), 'FORBIDDEN')).said).toBe('You do not have access to this resource.');
    expect(readFailure(new ApiError(403, unsaidFailure(403))).said).toBe(unsaidFailure(403));
  });

  it('says an unreached server as one, and keeps what the browser said', () => {
    expect(readFailure(new TypeError('Failed to fetch'))).toEqual({
      said: 'Forge could not be reached. Check your connection, then try again.',
      technical: 'Failed to fetch',
    });
  });
});

// ISS-1229 r25, judge-72: an organization name past its limit was refused with core's sentence naming
// the field and the limit, and the toast read the stock "Invalid input — please check the fields".
describe('a refused body core said why about', () => {
  const sentence =
    "An organization's name is at most 200 characters, so it was not saved. Shorten it, then save again.";

  it("shows core's own sentence", () => {
    expect(formatApiError(new ApiError(400, sentence, 'BAD_REQUEST'))).toBe(sentence);
  });

  it('keeps the stock sentence where core said only "Invalid input"', () => {
    expect(formatApiError(new ApiError(400, 'Invalid input', 'BAD_REQUEST'))).toBe(
      'Invalid input — please check the fields and try again.',
    );
  });
});
