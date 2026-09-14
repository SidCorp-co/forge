/**
 * ISS-1005 criterion 6 — the browser's door, judged where its facts are real.
 *
 * The unit file `src/assistant/web-door.test.ts` proves the three cases that
 * turn on `no-developer-detail`, and it can, because that rule declares
 * `needs: []` and reads nothing. This one cannot be done there. The rule that
 * makes `role:report` the RIGHT cell rather than merely a laxer one is
 * `STATUS_MATCHES_THE_ROW`, which declares `needs: ['prefixes', 'issue-rows']`
 * — and `gatherFacts` fetches neither unless the project holds the cited prefix
 * and the row is there to read. A unit test with `NO_FACTS` would assert a pass
 * that proved only that nothing had been gathered.
 *
 * So: a real project, its real prefix, a real issue row at one status, and a
 * reply asserting another — screened at the door `webConversationTurn` returns,
 * never at a door this file names.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_ISSUE_PREFIX } from '../../src/lib/issue-ref.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let screenReplyAtDoor: typeof import('../../src/messaging/reply-screen.js').screenReplyAtDoor;
let webConversationTurn: typeof import('../../src/assistant/conversation-send.js').webConversationTurn;

beforeAll(async () => {
  harness = await setupTestDatabase();
  // cm:guard imported AFTER the URL is assigned, for the reason `message-screen-e2e.test.ts` gives: `src/db/client.js` reads DATABASE_URL once at module load, so a static import binds the pool to the base database and every query lands in a schema the migrations never touched.
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  ({ screenReplyAtDoor } = await import('../../src/messaging/reply-screen.js'));
  ({ webConversationTurn } = await import('../../src/assistant/conversation-send.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

describe('the Forge UI reply door, against a real database', () => {
  /** The door production picks, read from production, never named here. */
  const webDoor = (project: { id: string; slug: string; name: string }) =>
    webConversationTurn({ project, handleName: 'Babo', askedBy: 'Alice' }).door;

  let nextSeq = 500;

  async function seed() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await createTestProjectMember(harness.db, {
      userId: owner.id,
      projectId: project.id,
      role: 'admin',
    });
    const rows = await harness.db.execute<{ issue_prefix: string | null; slug: string; name: string }>(sql`
      SELECT issue_prefix, slug, name FROM projects WHERE id = ${project.id}
    `);
    const row = rows[0] as { issue_prefix: string | null; slug: string; name: string };
    // cm:guard `?? LEGACY_ISSUE_PREFIX` is the fixture agreeing with `formatIssueRef` rather than a convenience: a fresh project stores NULL and still renders `ISS-n`, so a fixture reading the column literally would build a key nobody writes and watch the screen abstain.
    return {
      owner,
      project: { id: project.id, slug: row.slug, name: row.name },
      prefix: row.issue_prefix ?? LEGACY_ISSUE_PREFIX,
    };
  }

  /**
   * One issue row, at a status and either merged or not.
   */
  // cm:guard `merged_at` is written explicitly rather than inferred from the status, because that is the column `gather.ts` reads — it maps the fact as `mergedAt !== null`, so a row at `closed` with a null stamp is UNMERGED to this rule and a fixture that set only the status would be asserting against a fact nobody gathered.
  async function issue(
    projectId: string,
    ownerId: string,
    opts: { status: string; merged: boolean },
  ) {
    const seq = nextSeq++;
    const rows = await harness.db.execute<{ iss_seq: number }>(sql`
      INSERT INTO issues (project_id, title, created_by_id, status, iss_seq, merged_at)
      VALUES (${projectId}, 'target', ${ownerId}, ${opts.status}, ${seq},
              ${opts.merged ? sql`now()` : sql`NULL`})
      RETURNING iss_seq
    `);
    return (rows[0] as { iss_seq: number }).iss_seq;
  }

  const screen = (projectId: string, project: { id: string; slug: string; name: string }, text: string) =>
    screenReplyAtDoor(webDoor(project), {
      projectId,
      segments: [text],
      toolCalls: [],
      progress: null,
    });

  // cm:guard the claim is a MERGE and not an arbitrary status word, because a merge is what the rule judges: `status-assertions.ts` reads only `merged`/`shipped`/`landed` and `closed`, and abstains by design on everything else. A fixture asserting `in_progress` would watch the rule abstain and read that abstention as a hole in the door — which is exactly what the first draft of this file did (ISS-1005).
  it('refuses a reply claiming a merge the row does not hold', async () => {
    const { owner, project, prefix } = await seed();
    const seq = await issue(project.id, owner.id, { status: 'in_progress', merged: false });
    const verdict = await screen(project.id, project, `${prefix}-${seq} is merged.`);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.refusals.map((r) => r.rule)).toContain(
      'status-matches-the-row',
    );
  });

  it('lets the same sentence through once the row actually holds the merge', async () => {
    const { owner, project, prefix } = await seed();
    const seq = await issue(project.id, owner.id, { status: 'closed', merged: true });
    const verdict = await screen(project.id, project, `${prefix}-${seq} is merged.`);
    expect(verdict.ok).toBe(true);
  });

  // cm:guard the control that makes the pass above mean something: the SAME true sentence at the door the browser used to go out of is refused. Without it the passing case reads as "nothing was screened" rather than "the right cell screened it" — and the rule that refuses there, `only-verified-citations`, is one written for a reader who cannot open the tracker to check a reference. The Forge UI's reader can (ISS-1005).
  it('is refused at chat-sync even though the row agrees, which is why the door moved', async () => {
    const { owner, project, prefix } = await seed();
    const seq = await issue(project.id, owner.id, { status: 'closed', merged: true });
    const verdict = await screenReplyAtDoor('chat-sync', {
      projectId: project.id,
      segments: [`${prefix}-${seq} is merged, and the follow-up is on_hold.`],
      toolCalls: [],
      progress: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.refusals.map((r) => r.rule)).toContain('no-developer-detail');
  });
});
