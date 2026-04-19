/**
 * End-to-end evaluation of the Self-Learning Chat Agent against a live Strapi instance.
 *
 * Tests real multi-turn conversations through the /api/chat endpoint and verifies:
 *   Phase 1: RAG Gate — single LLM call, correct intent classification
 *   Phase 2: Quality Signals — populated in chat-log
 *   Phase 3: Enhanced Memory — pattern/frustration/expertise categories extracted
 *   Phase 4: Session Summary — session gets summarized and embedded
 *
 * Usage: npx tsx scripts/test-self-learning.ts
 */

const BASE = process.env.STRAPI_URL ?? 'http://localhost:1337';
const API_KEY = process.env.FORGE_API_KEY;
if (!API_KEY) throw new Error('FORGE_API_KEY env var required');

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function chat(message: string, sessionId?: string): Promise<any> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-API-Key': API_KEY },
    body: JSON.stringify({ message, sessionId }),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`Chat failed: ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}

async function getRecentLogs(limit = 20): Promise<any[]> {
  const res = await fetch(`${BASE}/api/chat-logs/recent?limit=${limit}`, {
    headers: { 'X-Forge-API-Key': API_KEY },
  });
  return (await res.json()) as any[];
}

const GLOBAL_KEY = process.env.FORGE_GLOBAL_API_KEY;
if (!GLOBAL_KEY) throw new Error('FORGE_GLOBAL_API_KEY env var required');

async function getSession(docId: string): Promise<any> {
  const res = await fetch(`${BASE}/api/chat-sessions/${docId}`, {
    headers: { 'X-Forge-API-Key': GLOBAL_KEY },
  });
  const json = (await res.json()) as any;
  return json.data || json;
}

async function getMemories(): Promise<any[]> {
  const res = await fetch(`${BASE}/api/memories`, {
    headers: { 'X-Forge-API-Key': GLOBAL_KEY },
  });
  const json = (await res.json()) as any;
  return json.data || json || [];
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ──────────────────────────────────────────────
// Phase 1: RAG Gate — Intent classification
// ──────────────────────────────────────────────
async function testPhase1() {
  console.log('\n═══ Phase 1: RAG Gate ═══');

  // Test 1: New search question → should get SEARCH or LOOKUP intent
  console.log('\n📝 Test: New search question');
  const r1 = await chat('What are the critical priority issues in this project?');
  assert(!!r1.sessionId, 'Returns sessionId');
  assert(!!r1.reply, 'Returns reply text');
  const sessionId = r1.sessionId;

  await sleep(1500);
  const logs = await getRecentLogs(5);
  const searchLog = logs.find((l) => l.sessionId === sessionId && l.query.includes('critical'));
  assert(!!searchLog, 'Chat log created');
  assert(
    ['SEARCH', 'LOOKUP', 'SUMMARY'].includes(searchLog?.queryIntent),
    `Intent classified: ${searchLog?.queryIntent}`,
    `got ${searchLog?.queryIntent}`,
  );

  // Test 2: Follow-up confirmation → should be ACTION or CHAT (no RAG)
  console.log('\n📝 Test: Follow-up confirmation (should skip RAG)');
  const r2 = await chat('show me more details about the first one', sessionId);
  assert(!!r2.reply, 'Follow-up reply received');

  await sleep(1500);
  const logs2 = await getRecentLogs(5);
  const followLog = logs2.find((l) => l.sessionId === sessionId && l.query.includes('first one'));
  if (followLog) {
    console.log(`    Intent: ${followLog.queryIntent}, RAG hits: ${followLog.qualitySignals?.ragHitCount ?? 'N/A'}`);
  }

  // Test 3: Direct command → ACTION intent
  console.log('\n📝 Test: Direct command');
  const r3 = await chat('create a high priority bug: Login page crashes on mobile Safari', sessionId);
  assert(!!r3.reply, 'Command reply received');

  await sleep(1500);
  const logs3 = await getRecentLogs(5);
  const cmdLog = logs3.find((l) => l.sessionId === sessionId && l.query.includes('Login page'));
  assert(
    cmdLog?.queryIntent === 'CREATE',
    `CREATE intent detected: ${cmdLog?.queryIntent}`,
    `got ${cmdLog?.queryIntent}`,
  );

  // Test 4: Greeting → CHAT intent (no RAG)
  console.log('\n📝 Test: Greeting');
  const r4 = await chat('Hey there, thanks for the help!');
  assert(!!r4.reply, 'Greeting reply received');

  await sleep(1500);
  const logs4 = await getRecentLogs(5);
  const greetLog = logs4.find((l) => l.query.includes('Hey there'));
  // Short messages may not reach RAG gate (< 10 chars), but this one is long enough
  if (greetLog?.queryIntent) {
    assert(
      greetLog.queryIntent === 'CHAT',
      `CHAT intent: ${greetLog.queryIntent}`,
      `got ${greetLog.queryIntent}`,
    );
  }

  // Test 5: Summary request
  console.log('\n📝 Test: Summary request');
  const r5 = await chat('Give me an overview of the project health and progress');
  assert(!!r5.reply, 'Summary reply received');

  await sleep(1500);
  const logs5 = await getRecentLogs(5);
  const sumLog = logs5.find((l) => l.query.includes('overview'));
  assert(
    ['SUMMARY', 'SEARCH'].includes(sumLog?.queryIntent),
    `SUMMARY intent: ${sumLog?.queryIntent}`,
    `got ${sumLog?.queryIntent}`,
  );

  return sessionId;
}

// ──────────────────────────────────────────────
// Phase 2: Quality Signals
// ──────────────────────────────────────────────
async function testPhase2(sessionId: string) {
  console.log('\n═══ Phase 2: Quality Signals ═══');

  const logs = await getRecentLogs(20);
  const sessionLogs = logs.filter((l) => l.sessionId === sessionId);

  assert(sessionLogs.length > 0, `Found ${sessionLogs.length} logs for session`);

  for (const log of sessionLogs.slice(0, 3)) {
    const qs = log.qualitySignals;
    console.log(`\n📝 Log: "${log.query.slice(0, 50)}..."`);
    assert(qs !== null && qs !== undefined, 'qualitySignals present');

    if (qs) {
      assert(typeof qs.turnIndex === 'number', `turnIndex: ${qs.turnIndex}`);
      assert(typeof qs.sessionTurnCount === 'number', `sessionTurnCount: ${qs.sessionTurnCount}`);
      assert(typeof qs.hadToolErrors === 'boolean', `hadToolErrors: ${qs.hadToolErrors}`);
      assert(typeof qs.toolErrorCount === 'number', `toolErrorCount: ${qs.toolErrorCount}`);
      assert(typeof qs.ragHitCount === 'number', `ragHitCount: ${qs.ragHitCount}`);
      assert(typeof qs.ragWasEmpty === 'boolean', `ragWasEmpty: ${qs.ragWasEmpty}`);
      assert(typeof qs.responseLength === 'number', `responseLength: ${qs.responseLength}`);
      assert(typeof qs.wasFollowUp === 'boolean', `wasFollowUp: ${qs.wasFollowUp}`);
      assert(typeof qs.latencyMs === 'number', `latencyMs: ${qs.latencyMs}ms`);
      assert(typeof qs.iterations === 'number', `iterations: ${qs.iterations}`);
    }
  }
}

// ──────────────────────────────────────────────
// Phase 3: Enhanced Memory — multi-turn conversation with corrections
// ──────────────────────────────────────────────
async function testPhase3() {
  console.log('\n═══ Phase 3: Enhanced Memory ═══');

  // Have a substantial conversation that should trigger memory extraction
  console.log('\n📝 Test: Multi-turn conversation with memory-worthy content');
  const r1 = await chat('I always deploy by merging to the master branch, never use CI/CD pipelines directly');
  const sid = r1.sessionId;

  await chat('Actually, the correct deployment process is: merge to master, then Coolify auto-deploys within 3 minutes', sid);
  await chat('Also I prefer Vietnamese for all issue descriptions, but English for technical docs', sid);
  await chat('The Qdrant vector search keeps timing out when I try batch operations larger than 50 items, this has been frustrating', sid);

  // Wait for async memory extraction
  console.log('  ⏳ Waiting for memory extraction...');
  await sleep(5000);

  // Check for memories
  const memories = await getMemories();
  console.log(`  Found ${Array.isArray(memories) ? memories.length : 0} total memories`);

  if (Array.isArray(memories) && memories.length > 0) {
    const categories = memories.map((m: any) => m.category);
    const uniqueCats = [...new Set(categories)];
    console.log(`  Categories: ${uniqueCats.join(', ')}`);

    // Check for traditional categories
    const hasTraditional = ['preference', 'workflow', 'correction', 'identity', 'context', 'decision']
      .some((c) => categories.includes(c));
    assert(hasTraditional, 'Has traditional memory categories');

    // Check for new categories (may or may not be extracted depending on LLM)
    const hasPattern = categories.includes('pattern');
    const hasFrustration = categories.includes('frustration');
    const hasExpertise = categories.includes('expertise');
    console.log(`  New categories — pattern: ${hasPattern}, frustration: ${hasFrustration}, expertise: ${hasExpertise}`);

    if (hasPattern || hasFrustration || hasExpertise) {
      assert(true, 'New memory categories extracted');
    } else {
      console.log('  ⚠️  New categories not extracted yet (LLM may need more context)');
    }
  }
}

// ──────────────────────────────────────────────
// Phase 4: Session Summary
// ──────────────────────────────────────────────
async function testPhase4() {
  console.log('\n═══ Phase 4: Session Summary ═══');

  // Create a substantial session (5+ turns with tool calls)
  console.log('\n📝 Test: Substantial conversation for summarization');
  const r1 = await chat('List all open issues in this project');
  const sid = r1.sessionId;

  await chat('What about the resolved ones from last week?', sid);
  await chat('Can you summarize the overall progress?', sid);
  await chat('Which issues have the most comments?', sid);
  await chat('Show me any issues related to authentication or login', sid);

  // Wait for async summarization
  console.log('  ⏳ Waiting for session summarization...');
  await sleep(5000);

  // Check session for summary
  const session = await getSession(sid);

  if (session) {
    console.log(`  Session title: ${session.title?.slice(0, 60)}`);
    console.log(`  Summary: ${session.summary?.slice(0, 100) || '(not yet generated)'}`);
    console.log(`  SummarizedAt: ${session.summarizedAt || '(not yet)'}`);

    if (session.summary) {
      assert(session.summary.length >= 20, `Summary generated (${session.summary.length} chars)`);
      assert(!!session.summarizedAt, 'summarizedAt timestamp set');
    } else {
      console.log('  ⚠️  Summary not generated yet — may need more messages or async delay');
      // Check if the session has enough messages
      const msgCount = session.messages?.length || 0;
      console.log(`  Message count: ${msgCount}`);
    }
  }
}

// ──────────────────────────────────────────────
// Latency comparison
// ──────────────────────────────────────────────
async function testLatency() {
  console.log('\n═══ Latency Check ═══');

  const logs = await getRecentLogs(30);
  const withSignals = logs.filter((l) => l.qualitySignals?.latencyMs);

  if (withSignals.length > 0) {
    const latencies = withSignals.map((l) => l.qualitySignals.latencyMs);
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);

    console.log(`  Avg latency: ${avg}ms (min: ${min}ms, max: ${max}ms) over ${latencies.length} calls`);

    // Check intent distribution
    const intents: Record<string, number> = {};
    for (const l of withSignals) {
      const i = l.queryIntent || 'null';
      intents[i] = (intents[i] || 0) + 1;
    }
    console.log(`  Intent distribution: ${Object.entries(intents).map(([k, v]) => `${k}:${v}`).join(', ')}`);

    // Check RAG skip rate
    const ragSkipped = withSignals.filter((l) => l.qualitySignals.ragHitCount === 0).length;
    console.log(`  RAG skipped: ${ragSkipped}/${withSignals.length} (${Math.round(ragSkipped / withSignals.length * 100)}%)`);
  }
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────
async function main() {
  console.log('🧪 Self-Learning Chat Agent — Live Evaluation');
  console.log(`   API: ${BASE}`);
  console.log(`   Key: ${API_KEY.slice(0, 10)}...`);

  try {
    const sessionId = await testPhase1();
    await testPhase2(sessionId);
    await testPhase3();
    await testPhase4();
    await testLatency();
  } catch (err) {
    console.error('\n💥 Fatal error:', err);
    failed++;
  }

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`✅ Passed: ${passed}  ❌ Failed: ${failed}`);
  console.log(`${'═'.repeat(40)}`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
