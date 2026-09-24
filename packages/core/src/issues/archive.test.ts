import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  archivedIssueSentence,
  issueArchiveFilterSchema,
  issueArchiveRequestSchema,
  issueArchiveSide,
  memoryOfLiveIssueAs,
} from './archive.js';

const PROJECT = '22222222-2222-4222-8222-222222222222';
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q);

describe('the archive filter', () => {
  it('refuses a filter naming neither keys nor statuses, which would match the whole project', () => {
    for (const filter of [{}, { seqBelow: 1000 }, { exclude: ['ISS-1'] }]) {
      const parsed = issueArchiveFilterSchema.safeParse(filter);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('every issue in the project');
    }
  });

  it('takes keys or statuses, alone or with the narrowing fields', () => {
    for (const filter of [
      { keys: ['ISS-1'] },
      { statuses: ['closed'] },
      { statuses: ['closed', 'dropped'], seqBelow: 1000, exclude: ['ISS-45'] },
    ]) {
      expect(issueArchiveFilterSchema.safeParse(filter).success).toBe(true);
    }
  });

  it('refuses an unknown field, an unknown status, an empty key list and a non-positive bound', () => {
    for (const filter of [
      { keys: ['ISS-1'], closedOnly: true },
      { statuses: ['archived'] },
      { keys: [] },
      { statuses: ['closed'], seqBelow: 0 },
    ]) {
      expect(issueArchiveFilterSchema.safeParse(filter).success).toBe(false);
    }
  });

  it('refuses a request body with anything beside filter and dryRun', () => {
    const body = { filter: { keys: ['ISS-1'] }, dryRun: true, force: true };
    expect(issueArchiveRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('the read-side predicates', () => {
  it('adds nothing when archived rows are asked for, and one condition otherwise', () => {
    expect(issueArchiveSide(true)).toEqual([]);
    expect(issueArchiveSide(undefined)).toHaveLength(1);
    expect(render(issueArchiveSide(false)[0] as never).sql).toBe('"issues"."archived_at" is null');
  });

  it('keeps every memory that is not an issue, and drops the text of the archived issues of this project', () => {
    const q = render(memoryOfLiveIssueAs('m', PROJECT));
    expect(q.sql).toContain("m.source <> 'issue' OR m.source_ref NOT IN");
    expect(q.sql).toContain('ai.archived_at IS NOT NULL');
    expect(q.params).toEqual([PROJECT]);
  });
});

describe('the refusal a write naming an archived issue gets', () => {
  it('names the issue and the exact call that unarchives it', () => {
    const sentence = archivedIssueSentence('ISS-45', PROJECT);
    expect(sentence).toContain('ISS-45 is archived');
    expect(sentence).toContain(`POST /api/projects/${PROJECT}/issues/unarchive`);
    expect(sentence).toContain('{"filter":{"keys":["ISS-45"]}}');
  });
});
