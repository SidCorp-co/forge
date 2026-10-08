/**
 * A key typed into the issues search, against real rows (ISS-1334).
 *
 * The search answered `q=ISS-1280` with the issues whose bodies cite ISS-1280 and never ISS-1280
 * itself. What a mocked db cannot show: that the key reaches `iss_seq` in Postgres, that the
 * prefixes held in `issue_prefix_aliases` decide what reads as a key, and that the MCP list answers
 * the same as the route.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  holdPrefixes,
  mcpList,
  member,
  neighbourhood,
  search,
  seedIssue,
  spendPrefix,
  useIssueSearchHarness,
} from '../helpers/issue-search-key.js';

useIssueSearchHarness();

describe('GET /api/projects/:id/issues/search — a key finds its issue (ISS-1334)', () => {
  it('answers ISS-1280 with ISS-1280 alone, not the issues citing it', async () => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const { res, body } = await search(project.id, user.id, 'ISS-1280');

    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.displayId)).toEqual(['ISS-1280']);
    expect(body.total).toBe(1);
  });

  it.each(['1280', 'iss-1280', '  ISS-1280  '])('answers %j with the same row', async (q) => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const { res, body } = await search(project.id, user.id, q);

    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.issSeq)).toEqual([1280]);
  });

  it('resolves the owner’s keys in a project with a prefix of its own, current, retired and legacy', async () => {
    const { user, project } = await member();
    await holdPrefixes(project.id, 'FP', ['FPL']);
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 2630,
      title: 'a',
      priority: 'critical',
    });
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 2295,
      title: 'b',
      description: 'FP-2630',
    });

    for (const [q, seq] of [
      ['ISS-2630', 2630],
      ['ISS-2295', 2295],
      ['FP-2630', 2630],
      ['fpl-2295', 2295],
    ] as const) {
      const { res, body } = await search(project.id, user.id, q);
      expect(res.status, q).toBe(200);
      expect(
        body.items.map((i) => i.displayId),
        q,
      ).toEqual([`FP-${seq}`]);
    }
  });

  it.each([
    'ISS 1280',
    'ISS - 1280',
    '#1280',
    '#ISS-1280',
    'ISS-1280,',
    'ISS-1280.',
    '(ISS-1280)',
    '`ISS-1280`',
  ])('answers the near-form %j with ISS-1280 alone, not its neighbours', async (q) => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const { res, body } = await search(project.id, user.id, q);

    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.displayId)).toEqual(['ISS-1280']);
    expect(body.total).toBe(1);
  });

  it.each([
    ['an en dash', 'ISS\u20131280'],
    ['an em dash', 'ISS\u20141280'],
    ['a fullwidth number sign', '\uFF031280'],
    ['a trailing zero-width space', 'ISS-1280\u200B'],
  ])('answers a key written with %s with ISS-1280 alone', async (_name, q) => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const { res, body } = await search(project.id, user.id, q);

    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.displayId)).toEqual(['ISS-1280']);
    expect(body.total).toBe(1);
  });

  it.each(['ISS-1280 ISS-1281', '#1280, #1281', 'ISS 1280 ISS 1281'])(
    'answers the keys pasted together as %j with exactly those rows',
    async (q) => {
      const { user, project } = await member();
      await neighbourhood(project.id, user.id);

      const { res, body } = await search(project.id, user.id, q);

      expect(res.status).toBe(200);
      expect(body.items.map((i) => i.issSeq).sort()).toEqual([1280, 1281]);
      expect(body.total).toBe(2);
    },
  );

  it('refuses a pasted list of keys whole by the one the project holds no issue at', async () => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const { res, body } = await search(project.id, user.id, 'ISS-1280 ISS-9999');

    expect(res.status).toBe(404);
    expect(body.code).toBe('ISSUE_KEY_NOT_HELD');
    expect(body.message).toContain('ISS-9999');
  });

  it('searches several bare numbers as text, since only one number alone reads as a key', async () => {
    const { user, project } = await member();
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 3,
      title: 'save answers 500 404 in the log',
    });

    const { res, body } = await search(project.id, user.id, '500 404');

    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.issSeq)).toEqual([3]);
  });

  it('answers a pasted link to this project’s issue page with that issue alone', async () => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);
    const id = await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 1290,
      title: 'linked',
    });

    const { res, body } = await search(
      project.id,
      user.id,
      `https://forge-beta.sidcorp.co/projects/forge-dev/issues/${id}`,
    );

    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.displayId)).toEqual(['ISS-1290']);
    expect(body.total).toBe(1);
  });

  it('searches a quoted number as text, the way round a bare number reading as a key', async () => {
    const { user, project } = await member();
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 500, title: 'other' });
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 3,
      title: 'save fails with HTTP 500',
    });

    const quoted = await search(project.id, user.id, '"500"');
    const worded = await search(project.id, user.id, 'HTTP 500');

    expect(quoted.res.status).toBe(200);
    expect(quoted.body.items.map((i) => i.issSeq)).toEqual([3]);
    expect(worded.body.items.map((i) => i.issSeq)).toEqual([3]);
  });

  it('answers a key whose issue is archived, as the list route’s key does', async () => {
    const { user, project } = await member();
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 7,
      title: 'gone',
      status: 'closed',
      archived: true,
    });

    const { body } = await search(project.id, user.id, 'ISS-7');

    expect(body.items.map((i) => i.issSeq)).toEqual([7]);
  });
});

describe('GET /api/projects/:id/issues/search — a key it cannot answer is refused by name (ISS-1334)', () => {
  it.each(['ISS-9999', '9999'])(
    'refuses %j by name when the project holds no such issue',
    async (q) => {
      const { user, project } = await member();
      await neighbourhood(project.id, user.id);
      await seedIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: 1,
        title: 'mentions ISS-9999 and 9999',
      });

      const { res, body } = await search(project.id, user.id, q);

      expect(res.status).toBe(404);
      expect(body.code).toBe('ISSUE_KEY_NOT_HELD');
      expect(body.message).toContain('ISS-9999');
    },
  );

  it('refuses a key whose prefix another project holds, naming the prefix', async () => {
    const { user, project } = await member();
    const other = await member();
    await holdPrefixes(other.project.id, 'OTH');
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 5,
      title: 'cites OTH-5',
    });

    const { res, body } = await search(project.id, user.id, 'OTH-5');

    expect(res.status).toBe(400);
    expect(body.code).toBe('ISSUE_KEY_FOREIGN_PREFIX');
    expect(body.message).toContain('`OTH`');
    expect(body.message).toContain('`ISS`');
  });

  it('refuses a pasted link to another project’s issue, naming its key and whose it is', async () => {
    const { user, project } = await member();
    const other = await member();
    await holdPrefixes(other.project.id, 'OTH');
    const id = await seedIssue({
      projectId: other.project.id,
      createdById: other.user.id,
      issSeq: 5,
      title: 'theirs',
    });

    const { res, body } = await search(
      project.id,
      user.id,
      `https://forge-beta.sidcorp.co/projects/oth/issues/${id}`,
    );

    expect(res.status).toBe(400);
    expect(body.code).toBe('ISSUE_KEY_FOREIGN_PREFIX');
    expect(body.message).toContain('`OTH-5`');
    expect(body.message).toContain('belongs to another project');
  });

  it('refuses a pasted link whose id no project holds, naming the id', async () => {
    const { user, project } = await member();
    const id = randomUUID();

    const { res, body } = await search(
      project.id,
      user.id,
      `https://forge-beta.sidcorp.co/projects/forge-dev/issues/${id}`,
    );

    expect(res.status).toBe(404);
    expect(body.code).toBe('ISSUE_KEY_NOT_HELD');
    expect(body.message).toContain(id);
  });

  it('refuses a prefix whose project is gone without saying another project holds it', async () => {
    const { user, project } = await member();
    await spendPrefix('GONE');

    const { res, body } = await search(project.id, user.id, 'GONE-5');

    expect(res.status).toBe(400);
    expect(body.code).toBe('ISSUE_KEY_FOREIGN_PREFIX');
    expect(body.message).toContain('no longer exists');
    expect(body.message).not.toContain('another project holds');
  });

  it.each(['0', 'ISS-0', '2147483648', '21474836470'])(
    'refuses %j as a number no issue can carry',
    async (q) => {
      const { user, project } = await member();
      await seedIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: 1,
        title: `about ${q}`,
      });

      const { res, body } = await search(project.id, user.id, q);

      expect(res.status).toBe(400);
      expect(body.code).toBe('ISSUE_KEY_OUT_OF_RANGE');
    },
  );
});

describe('issue search — text, filters and the MCP list beside a key (ISS-1334)', () => {
  it.each(['UTF-8', 'UTF-9999', 'UTF-0'])(
    'searches %j as text when no project ever held its prefix',
    async (q) => {
      const { user, project } = await member();
      await seedIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: 3,
        title: `breaks on ${q} input`,
      });
      await seedIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: 4,
        title: 'unrelated',
      });

      const { res, body } = await search(project.id, user.id, q);

      expect(res.status).toBe(200);
      expect(body.items.map((i) => i.issSeq)).toEqual([3]);
      expect(body.items[0]?.matchedFields).toEqual(['title']);
    },
  );

  it('searches a query with no key shape as text, newest first as before', async () => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const { body } = await search(project.id, user.id, 'ISS-1280 again');

    expect(body.items.map((i) => i.issSeq)).toEqual([1281]);
  });

  it('still narrows a key by status and priority', async () => {
    const { user, project } = await member();
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 8,
      title: 'x',
      priority: 'high',
    });

    const atOpen = await search(project.id, user.id, 'ISS-8', '&status=open&priority=high');
    const atClosed = await search(project.id, user.id, 'ISS-8', '&status=closed');
    const atLow = await search(project.id, user.id, 'ISS-8', '&priority=low');

    expect(atOpen.body.items.map((i) => i.issSeq)).toEqual([8]);
    expect(atClosed.res.status).toBe(200);
    expect(atClosed.body.items).toEqual([]);
    expect(atLow.body.items).toEqual([]);
  });

  it('answers the MCP list’s key search with the one row, and refuses an unheld key the same way', async () => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const hit = await mcpList(user.id, project.id, 'ISS-1280');

    expect(hit.issues.map((i) => i.issueId)).toEqual(['ISS-1280']);
    await expect(mcpList(user.id, project.id, 'ISS-9999')).rejects.toThrow(
      /^NOT_FOUND: ISSUE_KEY_NOT_HELD: .*ISS-9999/,
    );
    await expect(mcpList(user.id, project.id, '0')).rejects.toThrow(
      /^BAD_REQUEST: ISSUE_KEY_OUT_OF_RANGE: /,
    );
  });
  it('answers the MCP list’s pasted link, key list and dashed key as the route does', async () => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);
    const id = await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 1290,
      title: 'linked',
    });

    const link = await mcpList(
      user.id,
      project.id,
      `https://forge-beta.sidcorp.co/projects/forge-dev/issues/${id}`,
    );
    const both = await mcpList(user.id, project.id, 'ISS-1280 ISS-1281');
    const dashed = await mcpList(user.id, project.id, 'ISS\u20141280');

    expect(link.issues.map((i) => i.issueId)).toEqual(['ISS-1290']);
    expect(both.issues.map((i) => i.issueId).sort()).toEqual(['ISS-1280', 'ISS-1281']);
    expect(dashed.issues.map((i) => i.issueId)).toEqual(['ISS-1280']);
    await expect(mcpList(user.id, project.id, 'ISS-1280 ISS-9999')).rejects.toThrow(
      /^NOT_FOUND: ISSUE_KEY_NOT_HELD: .*ISS-9999/,
    );
    await expect(
      mcpList(
        user.id,
        project.id,
        `https://forge-beta.sidcorp.co/projects/x/issues/${randomUUID()}`,
      ),
    ).rejects.toThrow(/^NOT_FOUND: ISSUE_KEY_NOT_HELD: /);
  });
});
