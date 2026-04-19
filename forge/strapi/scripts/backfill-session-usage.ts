/**
 * One-time migration: backfill agent-session usage from local Claude CLI .jsonl files.
 * Reads JSONL locally, calls Strapi REST API to list/update sessions.
 *
 * Usage:
 *   STRAPI_USER=<user> STRAPI_PASS=<pass> npx tsx scripts/backfill-session-usage.ts           # dry-run
 *   STRAPI_USER=<user> STRAPI_PASS=<pass> npx tsx scripts/backfill-session-usage.ts --apply    # update
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const APPLY = process.argv.includes('--apply');
const API = process.env.STRAPI_URL || 'http://localhost:1337/api';
const USER = process.env.STRAPI_USER;
const PASS = process.env.STRAPI_PASS;

interface SessionUsage {
  contextUsed: number;
  inputTotal: number;
  outputTotal: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
}

function parseJsonlUsage(content: string): SessionUsage | null {
  let inputTotal = 0, outputTotal = 0, cacheRead = 0, cacheWrite = 0, turns = 0, contextUsed = 0;
  let lastMsgId: string | undefined;

  for (const line of content.split('\n')) {
    if (!line || !line.includes('"assistant"')) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed.type !== 'assistant') continue;
    const usage = parsed.message?.usage || parsed.usage;
    if (!usage) continue;
    const msgId = parsed.message?.id;
    if (msgId && msgId === lastMsgId) continue;
    lastMsgId = msgId;

    const inp = usage.input_tokens || 0;
    const out = usage.output_tokens || 0;
    const cr = usage.cache_read_input_tokens || 0;
    const cw = usage.cache_creation_input_tokens || 0;
    contextUsed = inp + cr + cw;
    inputTotal += inp;
    outputTotal += out;
    cacheRead += cr;
    cacheWrite += cw;
    turns++;
  }
  return turns > 0 ? { contextUsed, inputTotal, outputTotal, cacheRead, cacheWrite, turns } : null;
}

async function buildJsonlMap(): Promise<Map<string, string>> {
  const baseDir = join(homedir(), '.claude', 'projects');
  const map = new Map<string, string>();
  try {
    const entries = await readdir(baseDir, { withFileTypes: true, recursive: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        map.set(e.name.replace('.jsonl', ''), join((e as any).parentPath || (e as any).path, e.name));
      }
    }
  } catch {}
  return map;
}

async function getJwt(): Promise<string> {
  if (!USER || !PASS) throw new Error('Set STRAPI_USER and STRAPI_PASS');
  const res = await fetch(`${API}/auth/local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: USER, password: PASS }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data: any = await res.json();
  return data.jwt;
}

async function fetchAllSessions(jwt: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${API}/agent-sessions?pagination[page]=${page}&pagination[pageSize]=100&fields[0]=claudeSessionId&fields[1]=usage&fields[2]=title`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    if (!res.ok) throw new Error(`Fetch sessions failed: ${res.status}`);
    const json: any = await res.json();
    const data = json.data || [];
    all.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return all;
}

async function updateSession(jwt: string, docId: string, usage: SessionUsage): Promise<boolean> {
  const res = await fetch(`${API}/agent-sessions/${docId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { usage } }),
  });
  return res.ok;
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} | API: ${API}\n`);

  const jsonlMap = await buildJsonlMap();
  console.log(`JSONL files: ${jsonlMap.size}`);

  const jwt = await getJwt();
  console.log('Authenticated.\n');

  const sessions = await fetchAllSessions(jwt);
  console.log(`Sessions: ${sessions.length}\n`);

  let updated = 0, skipped = 0, noFile = 0;

  for (const s of sessions) {
    const claudeId = s.claudeSessionId;
    if (!claudeId) { skipped++; continue; }

    const existing = s.usage;
    if (existing?.turns > 0 && existing?.contextUsed > 100) { skipped++; continue; }

    const filePath = jsonlMap.get(claudeId);
    if (!filePath) { noFile++; continue; }

    let content: string;
    try { content = await readFile(filePath, 'utf-8'); } catch { noFile++; continue; }

    const usage = parseJsonlUsage(content);
    if (!usage) { noFile++; continue; }

    const label = (s.title || s.documentId).slice(0, 60);
    console.log(`  ${label}: ${usage.turns}t ctx=${usage.contextUsed}`);

    if (APPLY) {
      const ok = await updateSession(jwt, s.documentId, usage);
      if (!ok) console.log(`    FAILED: ${s.documentId}`);
      else updated++;
    } else {
      updated++;
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Total:    ${sessions.length}`);
  console.log(`${APPLY ? 'Updated' : 'Would update'}: ${updated}`);
  console.log(`Skipped:  ${skipped} (no claudeId or already has usage)`);
  console.log(`No file:  ${noFile}`);
  if (!APPLY && updated > 0) console.log(`\nRun with --apply to update.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
