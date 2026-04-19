import * as dotenv from 'dotenv';
dotenv.config();

const STRAPI = process.env.STRAPI_URL ?? 'http://localhost:1337';
const API_KEY = process.env.FORGE_API_KEY;
if (!API_KEY) {
  throw new Error('FORGE_API_KEY env var required');
}

async function chat(slug: string, sid: string | null, msg: string) {
  const resp = await fetch(`${STRAPI}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-API-Key': API_KEY },
    body: JSON.stringify({ projectSlug: slug, message: msg, ...(sid && { sessionId: sid }) }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const d = ((await resp.json()) as any).data;
  return { sid: d.sessionId, reply: d.reply || '' };
}

const VI_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

function say(label: string, text: string) {
  console.log(`  ${label}: ${text.slice(0, 250).replace(/\n/g, ' | ')}`);
}

async function run() {
  console.log('=== Test 1: Vietnamese → saved to memory → persists ===');
  const r1a = await chat('hrm', null, 'vấn đề chấm công gần đây');
  say('VI input', r1a.reply);
  console.log(`  Vietnamese reply: ${VI_CHARS.test(r1a.reply)}`);

  // Wait for memory to be saved
  await new Promise((r) => setTimeout(r, 1000));

  // Same session, English message → should still reply in Vietnamese (stored pref)
  const r1b = await chat('hrm', r1a.sid, 'show me the details');
  say('EN input (same session)', r1b.reply);
  console.log(`  Still Vietnamese: ${VI_CHARS.test(r1b.reply)}`);

  // New session, English message → should still be Vietnamese (memory persisted)
  const r1c = await chat('hrm', null, 'any open issues?');
  say('EN input (new session)', r1c.reply);
  console.log(`  Persisted Vietnamese: ${VI_CHARS.test(r1c.reply)}`);

  console.log('\n=== Test 2: English → no language saved → English reply ===');
  const r2 = await chat('forge-agents', null, 'show me open bugs');
  say('EN input', r2.reply);
  const isEN = !VI_CHARS.test(r2.reply);
  console.log(`  English reply: ${isEN}`);

  console.log('\n=== Test 3: Mixed EN/VI mid-conversation ===');
  const r3a = await chat('forge-agents', null, 'login page issues');
  say('T1 EN', r3a.reply);
  const r3b = await chat('forge-agents', r3a.sid, 'cái đó có nghiêm trọng không?');
  say('T2 VI', r3b.reply);
  console.log(`  Switched to Vietnamese: ${VI_CHARS.test(r3b.reply)}`);
}

run().catch(e => { console.error(e); process.exit(1); });
