/**
 * One-time migration: backfill agent-session usage from Claude CLI .jsonl files.
 * Runs on bootstrap — matches sessions by claudeSessionId → JSONL filename,
 * parses usage with message.id dedup, patches sessions with missing usage.
 * No-op if no JSONL files found (e.g. production server without CLI history).
 */
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

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

export async function backfillSessionUsage(strapi: any) {
  const jsonlMap = await buildJsonlMap();
  if (jsonlMap.size === 0) return; // no JSONL files — skip silently

  const knex = strapi.db.connection;
  const sessions: { id: number; claude_session_id: string; usage: any; title: string | null }[] =
    await knex('agent_sessions')
      .select('id', 'claude_session_id', 'usage', 'title')
      .whereNotNull('claude_session_id')
      .andWhere('claude_session_id', '!=', '');

  let updated = 0;
  for (const row of sessions) {
    const raw = row.usage;
    const existing = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (existing?.turns > 0 && existing?.contextUsed > 100) continue;

    const filePath = jsonlMap.get(row.claude_session_id);
    if (!filePath) continue;

    let content: string;
    try { content = await readFile(filePath, 'utf-8'); } catch { continue; }

    const usage = parseJsonlUsage(content);
    if (!usage) continue;

    // Postgres stores JSON natively, SQLite needs string
    const isPostgres = knex.client?.config?.client === 'pg';
    const val = isPostgres ? JSON.stringify(usage) : JSON.stringify(usage);
    await knex('agent_sessions').where('id', row.id).update({ usage: val });
    updated++;
  }

  if (updated > 0) {
    strapi.log.info(`[migration] Backfilled usage on ${updated} agent sessions from JSONL files`);
  }
}
