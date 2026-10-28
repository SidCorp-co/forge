/**
 * The rules on the state-machine writer, and WHO each one applies to.
 *
 * `no_work_evidence` holds against an agent only — a human hand-advance is a
 * recorded human decision. `entry_criteria` (ISS-959) holds against every
 * actor, because what the project declared is the project's rule and not a
 * defence against fabrication. `skip:true` exempts the whole checker but for the release note an
 * agent's close owes (ISS-1421 r15): that is the orchestrator's curated soft-skip/failover chain.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue: unknown[][] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => queue.shift() ?? [],
        }),
      }),
    }),
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const findMissingWorkEvidenceMock = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock('../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: (...args: unknown[]) => findMissingWorkEvidenceMock(...(args as [])),
}));

const findUnmetEntryCriteriaMock = vi.fn<() => Promise<{ unmet: unknown[] } | null>>(
  async () => null,
);
vi.mock('./entry-criteria.js', () => ({
  findUnmetEntryCriteria: (...args: unknown[]) => findUnmetEntryCriteriaMock(...(args as [])),
}));

const laneMock = vi.fn(async (..._a: unknown[]) => null as unknown);
vi.mock('./landing-evidence.js', () => ({
  readLandingEvidence: (...a: unknown[]) => laneMock(...a),
}));

const commitCheckMock = vi.fn(async (..._a: unknown[]) => 'checked' as string | null);
vi.mock('../projects/live-source.js', () => ({
  markCommitCheck: (...a: unknown[]) => commitCheckMock(...a),
}));

const { checkTransitionEvidence, isBlankPlan } = await import('./transition-evidence.js');

const ISSUE = { id: 'iss-1', projectId: 'proj-1' };

function _setup(...batches: unknown[][]) {
  queue.length = 0;
  queue.push(...batches);
}

const _planRow = (plan: string | null) => [{ plan }];
const _projectRow = (pipelineConfig: unknown) => [{ agentConfig: { pipelineConfig } }];

describe('isBlankPlan', () => {
  it.each([null, undefined, '', '   ', '\n\t'])('treats %j as blank', (v) => {
    expect(isBlankPlan(v)).toBe(true);
  });

  it.each(['a plan', '  a plan  '])('treats %j as non-blank', (v) => {
    expect(isBlankPlan(v)).toBe(false);
  });
});

describe('checkTransitionEvidence — no_work_evidence rule', () => {
  beforeEach(() => {
    findMissingWorkEvidenceMock.mockReset();
    findMissingWorkEvidenceMock.mockResolvedValue(null);
  });

  it('blocks a device transition to developed with no recorded evidence', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce('no branch or commit is recorded');
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'agent',
      skip: false,
      declaredCriteria: [],
    });
    expect(violation).toEqual({
      code: 'NO_WORK_EVIDENCE',
      detail: 'no branch or commit is recorded',
      details: { issueId: 'iss-1', toStatus: 'developed' },
    });
  });

  it('blocks a device transition to testing with no recorded evidence', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce('missing');
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'testing',
      agency: 'agent',
      skip: false,
      declaredCriteria: [],
    });
    expect(violation?.code).toBe('NO_WORK_EVIDENCE');
  });

  it('allows a device transition to developed when evidence exists', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'agent',
      skip: false,
      declaredCriteria: [],
    });
    expect(violation).toBeNull();
  });

  it('never checks evidence for closed/released — not claiming statuses', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce('missing');
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'agent',
      skip: false,
      declaredCriteria: [],
    });
    expect(violation).toBeNull();
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });

  it('allows a user actor even with no evidence (device-only enforcement)', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce('missing');
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'human',
      skip: false,
      declaredCriteria: [],
    });
    expect(violation).toBeNull();
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });

  it('allows options.skip:true (auto-skip/failover chain unaffected)', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce('missing');
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'agent',
      skip: true,
      declaredCriteria: [],
    });
    expect(violation).toBeNull();
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });
});

const resetRecordReaders = () => {
  findMissingWorkEvidenceMock.mockReset();
  findMissingWorkEvidenceMock.mockResolvedValue(null);
  findUnmetEntryCriteriaMock.mockReset();
  findUnmetEntryCriteriaMock.mockResolvedValue(null);
};

const shortfall = (...keys: string[]) => ({
  unmet: keys.map((key) => ({ key, detail: `no ${key} is written on this issue` })),
});

describe('checkTransitionEvidence — entry_criteria rule (ISS-959)', () => {
  beforeEach(resetRecordReaders);

  it('refuses a HUMAN transition on an unmet declared criterion — the half no rule reached before', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('plan'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan'],
    });
    expect(violation?.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(violation?.details).toEqual({
      issueId: ISSUE.id,
      toStatus: 'closed',
      unmet: ['plan'],
      steps: { plan: expect.any(String) },
    });
  });

  it('refuses an AGENT transition on the same unmet criterion', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('release_note'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'agent',
      skip: false,
      declaredCriteria: ['release_note'],
    });
    expect(violation?.code).toBe('ENTRY_CRITERIA_UNMET');
  });

  it('names the missing record in the detail, and names only what is unmet', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('plan'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan', 'acceptance_criteria', 'merged_mark'],
    });
    expect(violation?.detail).toBe(
      "This issue can't close yet: the plan is missing. An agent working this issue writes it; Open session or Reopen on its page starts one. If it turned out not to be work, move it to Dropped instead.",
    );
    expect(violation?.detail).not.toMatch(/acceptance|merge mark/i);
  });

  it('reads plural and singular from the shortfall it was given', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('plan', 'release_note'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan', 'release_note'],
    });
    expect(violation?.detail).toMatch(
      /^This issue can't close yet: the plan and the release note are missing\. /,
    );
  });

  // ISS-1421 r14 — judge-61 read one 71-word sentence naming records by stored key
  // ("acceptance_criteria — no `acceptanceCriteria` …").
  it('names every record by its name, in sentences of at most 20 words, never by stored key', async () => {
    const all = ['plan', 'acceptance_criteria', 'release_note', 'work_evidence', 'merged_mark'];
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall(...all));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: all as never,
    });
    const detail = violation?.detail ?? '';
    expect(detail).not.toMatch(
      /acceptance_criteria|release_note|work_evidence|merged_mark|acceptanceCriteria|releaseNotes|`/,
    );
    for (const sentence of detail.split(/(?<=\.) /)) {
      expect(sentence).toMatch(/^[A-Z].*\.$/);
      expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(20);
    }
    expect(detail).toMatch(
      /^This issue can't close yet: five records are missing\. They are the plan, /,
    );
    expect(violation?.details?.steps).toHaveProperty('merged_mark');
  });

  it('says which status the issue cannot move to when the move is not a close', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('acceptance_criteria'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'awaiting_release',
      agency: 'human',
      skip: false,
      declaredCriteria: ['acceptance_criteria'],
    });
    expect(violation?.detail).toMatch(
      /^This issue can't move to Awaiting release yet: the acceptance criteria are missing\. /,
    );
  });

  it('passes a transition whose declared criteria are all met', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan'],
    });
    expect(violation).toBeNull();
  });

  it('is exempt under the orchestrator skip flag, and never even asks', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('plan'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: true,
      declaredCriteria: ['plan'],
    });
    expect(violation).toBeNull();
    expect(findUnmetEntryCriteriaMock).not.toHaveBeenCalled();
  });

  it('hands the declared list straight through to the criteria reader', async () => {
    await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan', 'work_evidence'],
    });
    expect(findUnmetEntryCriteriaMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: ISSUE.id, declared: ['plan', 'work_evidence'] }),
    );
  });

  it('holds a human to `work_evidence` when the project DECLARES it, though the agent-only rule exempts them', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('work_evidence'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['work_evidence'],
    });
    expect(violation?.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });

  it('leaves a project that declared nothing byte-for-byte as before: no criteria read at all', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: [],
    });
    expect(violation).toBeNull();
    expect(findUnmetEntryCriteriaMock).toHaveBeenCalledWith(
      expect.objectContaining({ declared: [] }),
    );
  });
});

// ISS-1421 r15 — judge-65: an agent's close with three records missing was refused for the release
// note alone, by its stored key, and learnt of the plan and the criteria on a second refusal.
describe('an agent close, which owes a release note on every project', () => {
  beforeEach(resetRecordReaders);

  it('names every missing record in one refusal, the owed note beside the declared ones', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(
      shortfall('plan', 'acceptance_criteria', 'release_note'),
    );
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'agent',
      skip: false,
      declaredCriteria: ['plan', 'acceptance_criteria'],
      releaseNoteOwed: true,
    });
    expect(findUnmetEntryCriteriaMock).toHaveBeenCalledWith(
      expect.objectContaining({ declared: ['plan', 'acceptance_criteria', 'release_note'] }),
    );
    expect(violation?.code).toBe('RELEASE_RECORD_REQUIRED');
    expect(violation?.detail).toBe(
      "This issue can't close yet: the plan, the acceptance criteria and the release note are missing. An agent working this issue writes them; Open session or Reopen on its page starts one. If it turned out not to be work, move it to Dropped instead.",
    );
    expect(violation?.details).toMatchObject({
      requires: 'releaseNotes',
      unmet: ['plan', 'acceptance_criteria', 'release_note'],
    });
  });

  it('reads the same sentence a person reads for the same records, code aside', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('plan', 'release_note'));
    const agent = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'agent',
      skip: false,
      declaredCriteria: ['plan'],
      releaseNoteOwed: true,
    });
    const person = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan', 'release_note'],
    });
    expect(agent?.detail).toBe(person?.detail);
    expect(person?.code).toBe('ENTRY_CRITERIA_UNMET');
  });

  it('keeps ENTRY_CRITERIA_UNMET where the project declares the note itself', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('release_note'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'agent',
      skip: false,
      declaredCriteria: ['release_note'],
      releaseNoteOwed: true,
    });
    expect(violation?.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(findUnmetEntryCriteriaMock).toHaveBeenCalledWith(
      expect.objectContaining({ declared: ['release_note'] }),
    );
  });

  it('is ENTRY_CRITERIA_UNMET when the note is written and a declared record is not', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('plan'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'agent',
      skip: false,
      declaredCriteria: ['plan'],
      releaseNoteOwed: true,
    });
    expect(violation?.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(violation?.details).not.toHaveProperty('requires');
  });

  it('is not waived by a bare `skip`, which waives the declared records alone', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('release_note'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'agent',
      skip: true,
      declaredCriteria: ['plan'],
      releaseNoteOwed: true,
    });
    expect(violation?.code).toBe('RELEASE_RECORD_REQUIRED');
    expect(findUnmetEntryCriteriaMock).toHaveBeenCalledWith(
      expect.objectContaining({ declared: ['release_note'] }),
    );
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });

  it('owes nothing where no note is owed and nothing is declared', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'agent',
      skip: false,
      declaredCriteria: [],
      releaseNoteOwed: false,
    });
    expect(violation).toBeNull();
  });
});

// ISS-1421 r41 (criterion 393): a missing mark in git on a project naming no repository.
describe('a missing merge mark on a project naming no repository', () => {
  beforeEach(resetRecordReaders);

  const missingMark = async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('merged_mark'));
    return (
      await checkTransitionEvidence({
        issue: ISSUE,
        toStatus: 'awaiting_release',
        agency: 'human',
        skip: false,
        declaredCriteria: ['merged_mark'],
      })
    )?.detail;
  };

  it('says Commit may stay empty', async () => {
    laneMock.mockResolvedValue({ columns: {}, lane: { shape: 'git', declared: false } });
    commitCheckMock.mockResolvedValue('claim');
    expect(await missingMark()).toContain(
      "Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed; with no repository named, Commit may stay empty.",
    );
  });

  // ISS-1421 r42 (judge-169): on a project naming a repository the record never asked for the commit
  // the other places ask for.
  it('asks for the commit under Commit where the project names a repository', async () => {
    laneMock.mockResolvedValue({ columns: {}, lane: { shape: 'git', declared: false } });
    commitCheckMock.mockResolvedValue('checked');
    expect(await missingMark()).toContain(
      "Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed and name the commit that landed under Commit.",
    );
  });

  // ISS-1421 r43 (judge-171 on 407): a commit named on a repository Forge cannot read is refused, so
  // the record says what Mark merged's panel there says.
  it('says to leave Commit empty for a claim where Forge cannot read the named repository', async () => {
    laneMock.mockResolvedValue({ columns: {}, lane: { shape: 'git', declared: false } });
    commitCheckMock.mockResolvedValue('refused');
    const said = await missingMark();
    expect(said).toContain(
      "Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed and leave Commit empty to record a claim naming no commit.",
    );
    expect(said).not.toContain('name the commit that landed');
  });

  it('asks for where the work now is, and no commit, for work that lands outside git', async () => {
    laneMock.mockResolvedValue({ columns: {}, lane: { shape: 'outside_git', declared: true } });
    commitCheckMock.mockResolvedValue('claim');
    const said = await missingMark();
    expect(said).toContain(
      "Use Mark merged in the issue's properties. In the panel it opens, name the live URL, CMS entry or storefront resource in Where it landed.",
    );
    expect(said).not.toContain('Commit');
  });

  it('says only what the mark records where its lane cannot be read', async () => {
    laneMock.mockRejectedValue(new Error('read failed'));
    expect(await missingMark()).toContain(
      "Mark merged in the issue's properties records where the work landed.",
    );
  });

  it('still refuses when the lane cannot be read', async () => {
    laneMock.mockRejectedValueOnce(new Error('read failed'));
    expect(await missingMark()).toContain("Mark merged in the issue's properties");
  });
});
