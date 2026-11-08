/**
 * REQ-89 BC-7 (ISS-1121), against real Postgres: a fresh session asking for a current rule in
 * several phrasings — its exact name, an English paraphrase and a Vietnamese one — recalls the live
 * entry, through `POST /api/projects/:id/knowledge/search` and MCP `search` / `fetch` alike, and never
 * a retired or superseded entry, though one holding the very same words is planted beside it.
 *
 * Before this an org ruling was reachable only by its exact slug: knowledge search and MCP search
 * read the project's own store alone (forge-core-dev-36's read-path check, 2026-11-07).
 *
 * The embedder is a stand-in for the model (`helpers/word-vector.ts`): texts are as close as the
 * words they share. What this proves is the read path — org rulings ranked beside the project's own,
 * labelled, with their type, and retired entries left out — not the model's grasp of a paraphrase,
 * which the live recall check on forge-dev reads.
 *
 * @direct-test-of packages/core/src/knowledge/unified-search.ts
 * @direct-test-of packages/core/src/knowledge/org-recall.ts
 * @direct-test-of packages/core/src/knowledge/search.ts
 * @direct-test-of packages/core/src/mcp/records-search.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { wordVector } from '../helpers/word-vector.js';

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embed: async (_s: unknown, text: string) => wordVector(text),
  embedQuery: async (_s: unknown, text: string) => wordVector(text),
  embedBatch: async (_s: unknown, texts: string[]) => texts.map(wordVector),
}));

/** Five current rules, each with three phrasings of the question that should recall it. */
const RULES = [
  {
    slug: 'curated-memory',
    title: 'Curated memory',
    body: 'Chắt lọc ý định và kiến thức có thể tái sử dụng. Trước mỗi lần lưu memory, agent tự trả lời ba câu hỏi: giúp ích gì, đã có mục chưa, là sự thật, giả thuyết hay quy ước. Before saving memory an agent answers three questions: value, existing entry, fact or hypothesis.',
    asks: [
      'curated-memory',
      'which questions must an agent answer before saving memory',
      'trước khi lưu memory phải trả lời những câu hỏi nào',
    ],
  },
  {
    slug: 'decision-authority',
    title: 'Decision authority',
    body: 'Agents decide and execute; humans set policy. Bring a person in only for an irreversible decision, real money, credentials or product direction. Hỏi người chỉ khi quyết định không thể đảo ngược, tiền thật, thông tin đăng nhập hoặc hướng sản phẩm.',
    asks: [
      'decision-authority',
      'when must an agent bring a person in for a decision',
      'khi nào agent phải hỏi người quyết định',
    ],
  },
  {
    slug: 'batch-delivery',
    title: 'Batch delivery',
    body: 'Work moves in batches and new work folds into the running batch. One batch is one worktree and one branch, gated once, then one release. Công việc đi theo lô, mỗi lô một nhánh, một lần kiểm tra và một lần phát hành.',
    asks: [
      'batch-delivery',
      'how is work grouped into a batch before a release',
      'công việc được gom theo lô như thế nào trước khi phát hành',
    ],
  },
  {
    slug: 'token-budget',
    title: 'Token budget',
    body: 'Each subagent loads many tokens, so pace by urgency: parallel only for urgent work, otherwise one builder at a time. Mỗi subagent tốn nhiều token, chỉ chạy song song khi việc gấp.',
    asks: [
      'token-budget',
      'how many subagents may run in parallel and when',
      'khi nào được chạy song song nhiều subagent',
    ],
  },
  {
    slug: 'workspace-hygiene',
    title: 'Workspace hygiene',
    body: 'A run leaves its workspace as tidy as it found it: worktrees, scratch and temp folders, caches and leftover processes are removed when the work lands. Dọn worktree, thư mục tạm và tiến trình còn sót khi xong việc.',
    asks: [
      'workspace-hygiene',
      'what must a run remove from its workspace when the work lands',
      'dọn dẹp worktree và thư mục tạm khi xong việc',
    ],
  },
] as const;

const w = { projectId: '', orgId: '', token: '', pat: '' };
const live = new Map<string, string>();
const retired = new Set<string>();

beforeAll(async () => {
  const user = await createTestUser({ verified: true });
  const project = await createTestProject(user.id);
  await addProjectMember(project.id, user.id, 'owner');
  w.projectId = project.id;
  w.orgId = project.orgId;
  w.token = await userToken(user.id);
  // a fresh MCP session presents a personal access token, as any connector does
  w.pat = (
    await mintPat({
      permissions: ['*'],
      userId: user.id,
      name: 'recall',
      projectIds: null,
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;
  for (const rule of RULES) {
    const put = await api(w.token, 'PUT', `/api/orgs/${w.orgId}/knowledge/${rule.slug}`, {
      title: rule.title,
      body: rule.body,
      injection: 'on_demand',
      source: 'owner ruling',
      scope: 'every project of the org',
      recheckWhen: 'the owner rules again',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const [row] = await db.execute<{ id: string }>(
      sql`SELECT id FROM org_knowledge_entries WHERE org_id = ${w.orgId} AND slug = ${rule.slug}`,
    );
    live.set(rule.slug, (row as { id: string }).id);
    // the superseded copy holds the very same words, so only its retirement keeps it out
    const [old] = await db.execute<{ id: string }>(sql`
      INSERT INTO knowledge_entries (project_id, kind, slug, title, body, embedding, archived_at, entry_type)
      VALUES (${w.projectId}, 'rule', ${`${rule.slug}-old`}, ${rule.title}, ${rule.body},
              ${`[${wordVector(`${rule.title}\n\n${rule.body}`).join(',')}]`}::vector, now(), 'convention')
      RETURNING id`);
    retired.add((old as { id: string }).id);
    const [mem] = await db.execute<{ id: string }>(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, embedding, archived_at, metadata)
      VALUES (${w.projectId}, 'knowledge', ${`retired/${rule.slug}`}, ${rule.body},
              ${`[${wordVector(rule.body).join(',')}]`}::vector, now(), '{"retired":{"by":null,"at":"2026-11-07T00:00:00Z","reason":"superseded"}}'::jsonb)
      RETURNING id`);
    retired.add((mem as { id: string }).id);
  }
  // the project's own unrelated entries rank beside the org's
  await api(w.token, 'PUT', `/api/projects/${w.projectId}/knowledge/build-commands`, {
    kind: 'rule',
    title: 'Build commands',
    body: 'Build the web app with pnpm build and serve it from core.',
    type: 'fact',
    source: 'package.json',
    scope: 'this repo',
    recheckWhen: 'package.json scripts change',
  });
});

async function recall(query: string) {
  const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/knowledge/search`, {
    query,
    scope: 'all',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { knowledge: Body[]; memory: Body[] };
}

describe('BC-7: three phrasings of five current rules recall the live entry, never a retired one', () => {
  const cases = RULES.flatMap((r) => r.asks.map((ask) => [r.slug, ask] as const));

  it.each(cases)(
    '%s, asked as "%s", is recalled first, from the org, as a convention',
    async (slug, ask) => {
      const found = await recall(ask);
      expect(found.knowledge[0]).toMatchObject({ slug, origin: 'org', type: 'convention' });
      const ids = [...found.knowledge, ...found.memory].map((h) => h.id as string);
      expect(ids.filter((id) => retired.has(id))).toEqual([]);
    },
  );

  it('answers the same live entries by keyword, with no embedding at all', async () => {
    const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/knowledge/search`, {
      query: 'trước khi lưu memory phải trả lời những câu hỏi nào',
      strategy: 'keyword',
    });
    expect((res.body.knowledge as Body[])[0]).toMatchObject({
      slug: 'curated-memory',
      origin: 'org',
    });
  });
});

async function mcp(name: string, args: Record<string, unknown>) {
  const res = await api(
    w.pat,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const text = (res.body as { result: { content: { text: string }[] } }).result.content[0]?.text;
  return JSON.parse(text ?? '{}') as Body;
}

describe('BC-7: MCP search and fetch read the same entries', () => {
  it.each(RULES.map((r) => [r.slug, r.asks[2]] as const))(
    '%s is found by MCP search in Vietnamese and fetched whole',
    async (slug, ask) => {
      const found = (await mcp('search', { query: ask })).results as { id: string }[];
      const id = `org:${live.get(slug)}`;
      expect(found.map((r) => r.id)).toContain(id);
      expect(found.map((r) => r.id.split(':')[1])).not.toContain([...retired][0]);
      const whole = await mcp('fetch', { id });
      expect(whole.text).toBe(RULES.find((r) => r.slug === slug)?.body);
      expect(whole.metadata).toMatchObject({
        origin: 'org',
        slug,
        type: 'convention',
        current: true,
      });
    },
  );
});

// ISS-1142 (the ISS-1119 benchmark on forge data, 2026-11-08): in hybrid and keyword mode the org's
// rulings filled the top 5 and pushed out the project's lesson. A project entry had to hold every word
// of the query while an org ruling held any, and the two were merged by their fused scores, which
// capped a project hit at half an org hit's. Planted: six org rulings sharing three of the query's
// words, each out-scoring the exact project lesson on the old merge.
describe('ISS-1142: the project lesson a question asks for is recalled first in every strategy', () => {
  const ASK = 'what the master does when a landing push hangs';
  let lessonId = '';

  beforeAll(async () => {
    for (let i = 1; i <= 6; i += 1) {
      const put = await api(w.token, 'PUT', `/api/orgs/${w.orgId}/knowledge/master-note-${i}`, {
        title: `Master note ${i}`,
        body: `The master hangs a note ${i} on the board; a push of the board hangs the master view.`,
        injection: 'on_demand',
        source: 'owner ruling',
        scope: 'every project of the org',
        recheckWhen: 'the owner rules again',
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
    }
    const title = 'Stuck landing';
    const body = 'When a landing is stuck the master rebases on dev and retries the push once.';
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO knowledge_entries (project_id, kind, slug, title, body, embedding, entry_type)
      VALUES (${w.projectId}, 'rule', 'stuck-landing-retry', ${title}, ${body},
              ${`[${wordVector(`${title}\n\n${body}`).join(',')}]`}::vector, 'fact')
      RETURNING id`);
    lessonId = (row as { id: string }).id;
  });

  it.each(['semantic', 'hybrid', 'keyword'] as const)(
    'recalls it first by %s, ahead of the org rulings sharing the question’s words',
    async (strategy) => {
      const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/knowledge/search`, {
        query: ASK,
        scope: 'knowledge',
        strategy,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const found = (res.body.knowledge as Body[]).map((h) => h.id as string);
      expect(found[0], JSON.stringify(found)).toBe(lessonId);
      expect(found.length).toBeGreaterThan(1);
    },
  );
});
