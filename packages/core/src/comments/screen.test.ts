import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectWhere = vi.fn();
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));
vi.mock('../issues/issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => 'ISS',
  heldIssuePrefixes: async () => ['ISS'],
}));

const { screenAgentComment, messageRefusalHttp } = await import('./screen.js');
const { db } = await import('../db/client.js');

/** What the tracker holds for the issues a comment names. */
const tracker = (rows: Array<{ issSeq: number; status: string; mergedAt: Date | null }>) => {
  selectWhere.mockResolvedValue(
    rows.map((r) => ({
      id: randomUUID(),
      issSeq: r.issSeq,
      status: r.status,
      mergedAt: r.mergedAt,
    })),
  );
};

const screen = (body: string) => screenAgentComment('proj-1', body, db as never);
const refusalOf = async (body: string): Promise<string> => {
  try {
    await screen(body);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected ${JSON.stringify(body)} to be refused, and it was written`);
};

beforeEach(() => {
  selectWhere.mockReset();
  selectWhere.mockResolvedValue([]);
});

describe('what an agent may claim to the person who decides', () => {
  it('refuses a merge the tracker does not hold', async () => {
    tracker([{ issSeq: 42, status: 'in_progress', mergedAt: null }]);
    const message = await refusalOf('ISS-42 is merged and deployed.');
    expect(message).toContain('the tracker holds no a merge for it');
    expect(message).toContain('rule: status-matches-the-row');
  });

  it('refuses a closure the tracker does not hold', async () => {
    tracker([{ issSeq: 42, status: 'developed', mergedAt: new Date() }]);
    const message = await refusalOf('ISS-42 is closed.');
    expect(message).toContain('rule: status-matches-the-row');
    expect(message).toContain('ISS-42 is developed');
  });

  it('writes a merge the tracker does hold', async () => {
    tracker([{ issSeq: 42, status: 'developed', mergedAt: new Date() }]);
    await expect(screen('ISS-42 merged at 4366e63e.')).resolves.toBeUndefined();
  });

  it('says nothing about an issue this project does not hold, because that is another project’s key', async () => {
    tracker([]);
    await expect(
      screen('Filed as forge-plugin ISS-1386; the workaround cost three hours.'),
    ).resolves.toBeUndefined();
  });

  it('writes a comment that denies a status', async () => {
    tracker([{ issSeq: 42, status: 'in_progress', mergedAt: null }]);
    await expect(screen('ISS-42 is not merged yet.')).resolves.toBeUndefined();
  });

  it('refuses a comment that would page the whole room it is mirrored into', async () => {
    expect(await refusalOf('@all please look at this')).toContain('rule: no-room-broadcast');
  });

  it('refuses a comment carrying what the scrubber would redact', async () => {
    expect(await refusalOf('the call was token=abcdef123456')).toContain(
      'rule: no-redacted-secret',
    );
  });

  it('refuses a comment with no text at all', async () => {
    expect(await refusalOf('   ')).toContain('rule: comment-has-text');
  });

  it('writes the developer detail a report to somebody holding a role is made of', async () => {
    tracker([{ issSeq: 42, status: 'developed', mergedAt: new Date() }]);
    await expect(
      screen(
        'ISS-42 merged at 4366e63e; the fix is in packages/core/src/index.ts:44 and it is developed.',
      ),
    ).resolves.toBeUndefined();
  });

  it('makes no query at all for a comment that names no issue', async () => {
    await expect(
      screen('The deploy is done and the walk is on the issue.'),
    ).resolves.toBeUndefined();
    expect(selectWhere).not.toHaveBeenCalled();
  });
});

describe('what the refusal hands back', () => {
  it('names the rule, the shape and an example, so a rewrite is not a guess', async () => {
    tracker([{ issSeq: 42, status: 'in_progress', mergedAt: null }]);
    const message = await refusalOf('ISS-42 is merged.');
    expect(message).toContain('rule: status-matches-the-row');
    expect(message).toContain('shape: record it on the tracker first and then say so');
    expect(message).toContain('for example: The branch is pushed and the PR is open');
  });

  it('becomes a 400 carrying that message verbatim', async () => {
    tracker([{ issSeq: 42, status: 'in_progress', mergedAt: null }]);
    let thrown: unknown;
    try {
      await screen('ISS-42 is merged.');
    } catch (err) {
      thrown = err;
    }
    const http = messageRefusalHttp(thrown);
    expect(http?.status).toBe(400);
    expect(http?.message).toBe((thrown as Error).message);
  });

  it('passes anything that is not a refused message straight through', () => {
    expect(messageRefusalHttp(new Error('something else'))).toBeNull();
  });
});
