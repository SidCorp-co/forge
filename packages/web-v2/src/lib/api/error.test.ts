import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import {
  describeSettings,
  formatApiError,
  formatApiReason,
  formatPipelineConfigError,
  formatSettingsWriteError,
  isRetryableApiError,
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
  const AGENT_SENTENCE = 'x '.repeat(142);

  it('names Mark merged and "Where it landed" for a website close, in at most 60 words', () => {
    for (const held of ['unmarked', 'asserted']) {
      const msg = formatApiError(
        new ApiError(422, AGENT_SENTENCE, 'CLOSE_REQUIRES_SHIPPED', { requires: 'mergedLanding', held }),
      );
      expect(msg).toContain('Mark merged');
      expect(msg).toContain('“Where it landed”');
      expect(words(msg)).toBeLessThanOrEqual(60);
    }
  });

  it('says Unmark first where the mark that stands names no landing', () => {
    const msg = formatApiError(
      new ApiError(422, AGENT_SENTENCE, 'CLOSE_REQUIRES_SHIPPED', { requires: 'mergedLanding', held: 'asserted' }),
    );
    expect(msg).toContain('press Unmark first');
  });

  it('names Mark merged and no landing for a close on a project that lands in git', () => {
    const msg = formatApiError(new ApiError(422, AGENT_SENTENCE, 'CLOSE_REQUIRES_SHIPPED', { requires: 'mergedAt' }));
    expect(msg).toContain('Mark merged');
    expect(msg).not.toContain('landed');
  });

  it('names the landing that stands, and Unmark, for a refused correction', () => {
    const msg = formatApiError(
      new ApiError(422, 'core sentence', 'MARK_ALREADY_STANDS', { heldLanding: 'https://shop.example.com/a' }),
    );
    expect(msg).toContain('https://shop.example.com/a');
    expect(msg).toContain('press Unmark');
    expect(msg).toContain('nothing changed');
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
    'connection 2679a042 is not one you can reach. Ask its owner, or an admin of a project it is bound to, to bind it to a project you administer.';

  it('prints the server sentence for a connection the caller cannot reach, not "Not found."', () => {
    const err = new ApiError(404, reachable, 'CONNECTION_NOT_REACHABLE');
    expect(formatApiError(err)).toBe(reachable);
  });

  it('prints the server sentence for a connection the caller may read but not change', () => {
    const sentence = 'you can see connection 2679a042 but not change it: Ask its owner.';
    const err = new ApiError(403, sentence, 'CONNECTION_NOT_MANAGEABLE');
    expect(formatApiError(err)).toBe(sentence);
  });

  it('still prints the generic phrase for a plain NOT_FOUND, which is what the named codes are not', () => {
    expect(formatApiError(new ApiError(404, 'connection not found', 'NOT_FOUND'))).toBe('Not found.');
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
  it('is said as a failed request, not echoed', () => {
    expect(formatApiError(new ApiError(500, 'Internal Server Error'))).toBe(
      'The server could not complete the request (500).',
    );
    expect(formatApiError(new ApiError(503, 'Service Unavailable'))).toBe(
      'The server could not complete the request (503).',
    );
  });

  it('covers every standard 5xx status text, whole-message only', () => {
    expect(formatApiError(new ApiError(501, 'Not Implemented'))).toBe('The server could not complete the request (501).');
    expect(formatApiError(new ApiError(505, 'HTTP Version Not Supported'))).toBe(
      'The server could not complete the request (505).',
    );
    expect(formatApiError(new ApiError(501, 'Not Implemented for this provider'))).toBe(
      'Not Implemented for this provider',
    );
  });

  it("keeps a server error's own words, and a client error's status text", () => {
    expect(formatApiError(new ApiError(500, 'the plugins store is down'))).toBe('the plugins store is down');
    expect(formatApiError(new ApiError(400, 'Internal Server Error'))).toBe('Internal Server Error');
  });

  it('ends a reason with a stop so the next sentence starts after one', () => {
    expect(formatApiReason(new ApiError(500, 'the plugins store is down'))).toBe('the plugins store is down.');
    expect(formatApiReason(new ApiError(404, 'Not found.'))).toBe('Not found.');
    expect(formatApiReason(new ApiError(500, 'Internal Server Error'))).toBe(
      'The server could not complete the request (500).',
    );
  });
});
