/**
 * Evaluate RAG pipeline with knowledge graph edges on prod.
 * Sends test queries and checks if edge context is used.
 *
 * Usage: npx tsx scripts/eval-rag-with-kg.ts
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337/api';
const STRAPI_USER = process.env.STRAPI_USER || '';
const STRAPI_PASSWORD = process.env.STRAPI_PASSWORD || '';

async function getJWT(): Promise<string> {
  const resp = await fetch(`${STRAPI_URL}/auth/local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: STRAPI_USER, password: STRAPI_PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
  const data = (await resp.json()) as any;
  console.log('Authenticated as', data.user?.username);
  return data.jwt;
}

// Test queries designed to trigger knowledge graph edge expansion
const TEST_QUERIES = [
  {
    query: 'trang attendance có những rule gì?',
    expectEdges: ['attendance', 'has_rule'],
    description: 'Should find attendance rules via edges',
  },
  {
    query: 'HR admin quản lý những trang nào?',
    expectEdges: ['hr admin', 'owns'],
    description: 'Should find HR admin page ownership via edges',
  },
  {
    query: 'chấm công liên quan gì đến approvals?',
    expectEdges: ['chấm công', 'approvals'],
    description: 'Should bridge attendance to approvals via edges',
  },
  {
    query: 'nexus và forge liên quan gì nhau?',
    expectEdges: ['nexus', 'forge'],
    description: 'Should find nexus-forge relationship',
  },
  {
    query: 'employee page có filter gì?',
    expectEdges: ['/employees', 'search'],
    description: 'Should find employee search filter rules',
  },
];

async function main() {
  const jwt = await getJWT();

  // First verify edges exist
  const edgeResp = await fetch(`${STRAPI_URL}/knowledge-edges?pagination%5Blimit%5D=1`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const edgeData = (await edgeResp.json()) as any;
  console.log(`Knowledge edges in prod: ${edgeData.meta?.pagination?.total || 0}\n`);

  // Also check what edges exist for attendance-related entities
  const attendanceEdges = await fetch(
    `${STRAPI_URL}/knowledge-edges?filters%5Bsubject%5D%5B%24containsi%5D=attendance&pagination%5Blimit%5D=10`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  );
  const aData = (await attendanceEdges.json()) as any;
  console.log('Sample attendance edges:');
  for (const e of (aData.data || []).slice(0, 5)) {
    console.log(`  ${e.subject} —${e.predicate}→ ${e.object}${e.value ? ': ' + e.value : ''}`);
  }

  const hrEdges = await fetch(
    `${STRAPI_URL}/knowledge-edges?filters%5Bsubject%5D%5B%24containsi%5D=hr&pagination%5Blimit%5D=10`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  );
  const hData = (await hrEdges.json()) as any;
  console.log('\nSample HR edges:');
  for (const e of (hData.data || []).slice(0, 5)) {
    console.log(`  ${e.subject} —${e.predicate}→ ${e.object}${e.value ? ': ' + e.value : ''}`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('SENDING TEST QUERIES TO PROD CHAT API\n');

  for (let i = 0; i < TEST_QUERIES.length; i++) {
    const test = TEST_QUERIES[i];
    console.log(`\n--- Test ${i + 1}: ${test.description} ---`);
    console.log(`Query: "${test.query}"`);

    try {
      const resp = await fetch(`${STRAPI_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          projectSlug: 'hrm',
          message: test.query,
          sessionId: `eval-kg-${Date.now()}-${i}`,
        }),
      });

      if (!resp.ok) {
        console.log(`  ERROR: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
        continue;
      }

      const data = (await resp.json()) as any;
      const sessionId = data.data?.sessionId;
      const reply = data.data?.reply || '';
      console.log(`\nReply (first 500 chars):\n${reply.slice(0, 500)}`);

      // Fetch chat log to get ragContext, queryIntent, condensedQuery
      if (sessionId) {
        await new Promise((r) => setTimeout(r, 1000)); // wait for log write
        const logResp = await fetch(
          `${STRAPI_URL}/chat-logs?filters%5BsessionId%5D%5B%24eq%5D=${sessionId}&sort=createdAt:desc&pagination%5Blimit%5D=1`,
          { headers: { Authorization: `Bearer ${jwt}` } },
        );
        const logData = (await logResp.json()) as any;
        const log = logData.data?.[0];
        if (log) {
          const ragContext = log.ragContext || [];
          const memEntries = ragContext.filter((r: any) => r.type === 'memory');
          const issueEntries = ragContext.filter((r: any) => r.type === 'issue');
          console.log(`\nRAG: ${ragContext.length} total | ${issueEntries.length} issues | ${memEntries.length} memories`);
          console.log(`Intent: ${log.queryIntent || 'n/a'} | Condensed: ${log.condensedQuery || 'n/a'}`);
          if (ragContext.length > 0) {
            console.log('RAG entries:');
            for (const r of ragContext.slice(0, 5)) {
              console.log(`  [${r.type}] score=${r.score} ${(r.text || '').slice(0, 80)}`);
            }
          }
        }
      }

      // Check if reply content suggests knowledge graph edges were used
      const replyLower = reply.toLowerCase();
      const edgeHits = test.expectEdges.filter((e) => replyLower.includes(e.toLowerCase()));
      console.log(`Edge keyword hits in reply: ${edgeHits.length}/${test.expectEdges.length} (${edgeHits.join(', ')})`);
    } catch (err) {
      console.log(`  ERROR: ${err}`);
    }

    // Delay between queries
    if (i < TEST_QUERIES.length - 1) await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('\n' + '='.repeat(70));
  console.log('EVAL COMPLETE');
}

main().catch(console.error);
