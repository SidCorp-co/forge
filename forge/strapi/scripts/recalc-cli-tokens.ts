/**
 * Recalculate token usage from stored Claude CLI .jsonl session files.
 *
 * Usage:
 *   npx tsx scripts/recalc-cli-tokens.ts                    # all projects
 *   npx tsx scripts/recalc-cli-tokens.ts --project jarvis   # filter by project name
 *   npx tsx scripts/recalc-cli-tokens.ts --session <uuid>   # single session
 *   npx tsx scripts/recalc-cli-tokens.ts --include-subagents # include subagent sessions
 *   npx tsx scripts/recalc-cli-tokens.ts --json              # output as JSON
 */

import { readdir, readFile } from 'fs/promises';
import { join, sep } from 'path';
import { homedir } from 'os';

// ── Pricing (per million tokens) ──
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6':        { input: 15,   output: 75,  cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-6':      { input: 3,    output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-sonnet-4-5':      { input: 3,    output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5':       { input: 1,    output: 5,   cacheRead: 0.1,  cacheWrite: 1.25 },
};

function findPricing(model: string) {
  const stripped = model.includes('/') ? model.split('/').pop()! : model;
  let p = PRICING[stripped];
  if (!p) {
    const key = Object.keys(PRICING).find(k => stripped.startsWith(k));
    if (key) p = PRICING[key];
  }
  return p ?? { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }; // default to opus
}

interface UsageEntry {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

interface SessionResult {
  sessionId: string;
  project: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCost: number;
  firstTimestamp: string;
  lastTimestamp: string;
  subagentCount: number;
  subagentTokens: number;
  filePath: string;
}

async function findJsonlFiles(baseDir: string, includeSubagents: boolean): Promise<string[]> {
  try {
    const entries = await readdir(baseDir, { withFileTypes: true, recursive: true });
    return entries
      .filter(e => {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) return false;
        const fullPath = join((e as any).parentPath ?? (e as any).path, e.name);
        const isSubagent = fullPath.includes('/subagents/');
        return includeSubagents || !isSubagent;
      })
      .map(e => join((e as any).parentPath ?? (e as any).path, e.name));
  } catch {
    return [];
  }
}

function parseSession(content: string): {
  usage: UsageEntry;
  requests: number;
  model: string;
  firstTs: string;
  lastTs: string;
} {
  let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0;
  let requests = 0, model = 'unknown', firstTs = '', lastTs = '';
  let lastMsgId: string | null = null;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed.type !== 'assistant') continue;

    const msg = parsed.message;
    if (!msg?.usage) continue;

    // Claude CLI emits multiple entries per API turn (same message.id)
    // — one per content block (thinking, text, tool_use). Deduplicate.
    const msgId = msg.id;
    if (msgId && msgId === lastMsgId) continue;
    lastMsgId = msgId ?? null;

    const u = msg.usage;
    inputTokens += u.input_tokens || 0;
    outputTokens += u.output_tokens || 0;
    cacheRead += u.cache_read_input_tokens || 0;
    cacheWrite += u.cache_creation_input_tokens || 0;
    requests++;
    if (msg.model) model = msg.model;
    const ts = parsed.timestamp || '';
    if (ts && !firstTs) firstTs = ts;
    if (ts) lastTs = ts;
  }

  return {
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
    requests, model, firstTs, lastTs,
  };
}

async function processFile(file: string, claudeDir: string): Promise<SessionResult | null> {
  const content = await readFile(file, 'utf-8');
  const { usage, requests, model, firstTs, lastTs } = parseSession(content);
  if (requests === 0) return null;

  const relativePath = file.slice(claudeDir.length);
  const parts = relativePath.split(sep).filter(Boolean);
  const sessionId = parts[parts.length - 1]?.replace('.jsonl', '') || 'unknown';
  const project = parts.length > 1 ? parts[0] : 'unknown';

  // Check for subagent files
  const dir = file.replace(/\/[^/]+$/, '');
  let subagentCount = 0, subagentTokens = 0;
  try {
    const subDir = join(dir, sessionId, 'subagents');
    const subFiles = await readdir(subDir);
    for (const sf of subFiles) {
      if (!sf.endsWith('.jsonl')) continue;
      subagentCount++;
      const subContent = await readFile(join(subDir, sf), 'utf-8');
      const sub = parseSession(subContent);
      subagentTokens += sub.usage.input_tokens + sub.usage.output_tokens + sub.usage.cache_read_input_tokens + sub.usage.cache_creation_input_tokens;
    }
  } catch { /* no subagents dir */ }

  const pricing = findPricing(model);
  const cost =
    (usage.input_tokens * pricing.input +
     usage.output_tokens * pricing.output +
     usage.cache_read_input_tokens * pricing.cacheRead +
     usage.cache_creation_input_tokens * pricing.cacheWrite) / 1_000_000;

  return {
    sessionId,
    project,
    model,
    requests,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
    estimatedCost: cost,
    firstTimestamp: firstTs,
    lastTimestamp: lastTs,
    subagentCount,
    subagentTokens,
    filePath: file,
  };
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const projectFilter = args.includes('--project') ? args[args.indexOf('--project') + 1]?.toLowerCase() : null;
  const sessionFilter = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;
  const includeSubagents = args.includes('--include-subagents');
  const jsonOutput = args.includes('--json');

  const claudeDir = join(homedir(), '.claude', 'projects') + sep;
  const files = await findJsonlFiles(claudeDir.slice(0, -1), includeSubagents);

  if (files.length === 0) {
    console.log('No .jsonl files found in', claudeDir);
    return;
  }

  // Process all files
  const BATCH = 20;
  const results: SessionResult[] = [];
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(f => processFile(f, claudeDir)));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        const v = r.value;
        // Apply filters
        if (projectFilter && !v.project.toLowerCase().includes(projectFilter)) continue;
        if (sessionFilter && v.sessionId !== sessionFilter) continue;
        results.push(v);
      }
    }
  }

  // Sort by cost descending
  results.sort((a, b) => b.estimatedCost - a.estimatedCost);

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // ── Summary by project ──
  const byProject = new Map<string, { sessions: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; subagents: number; subTokens: number }>();
  for (const r of results) {
    const p = byProject.get(r.project) || { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, subagents: 0, subTokens: 0 };
    p.sessions++;
    p.input += r.inputTokens;
    p.output += r.outputTokens;
    p.cacheRead += r.cacheReadTokens;
    p.cacheWrite += r.cacheWriteTokens;
    p.cost += r.estimatedCost;
    p.subagents += r.subagentCount;
    p.subTokens += r.subagentTokens;
    byProject.set(r.project, p);
  }

  // Grand totals
  const totals = { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0, subagents: 0, subTokens: 0 };
  for (const r of results) {
    totals.sessions++;
    totals.input += r.inputTokens;
    totals.output += r.outputTokens;
    totals.cacheRead += r.cacheReadTokens;
    totals.cacheWrite += r.cacheWriteTokens;
    totals.cost += r.estimatedCost;
    totals.requests += r.requests;
    totals.subagents += r.subagentCount;
    totals.subTokens += r.subagentTokens;
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Claude CLI Token Usage Report');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  console.log(`  Sessions scanned:  ${formatNumber(results.length)} (from ${formatNumber(files.length)} files)`);
  console.log(`  API requests:      ${formatNumber(totals.requests)}`);
  console.log(`  Subagent sessions: ${formatNumber(totals.subagents)}`);
  console.log();

  // Token breakdown
  console.log('  ── Token Breakdown ──');
  console.log(`  Input tokens:          ${formatNumber(totals.input).padStart(15)}`);
  console.log(`  Output tokens:         ${formatNumber(totals.output).padStart(15)}`);
  console.log(`  Cache read tokens:     ${formatNumber(totals.cacheRead).padStart(15)}`);
  console.log(`  Cache write tokens:    ${formatNumber(totals.cacheWrite).padStart(15)}`);
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Total tokens:          ${formatNumber(totals.input + totals.output + totals.cacheRead + totals.cacheWrite).padStart(15)}`);
  if (totals.subTokens > 0) {
    console.log(`  Subagent tokens:       ${formatNumber(totals.subTokens).padStart(15)}`);
  }
  console.log();

  console.log('  ── Estimated Cost (per-model pricing applied) ──');
  console.log(`  Total estimated cost:  ${formatCost(totals.cost).padStart(15)}`);
  console.log();

  // Per-project breakdown
  console.log('  ── By Project ──');
  const sortedProjects = [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost);
  for (const [proj, p] of sortedProjects) {
    const shortName = proj.length > 50 ? '...' + proj.slice(-47) : proj;
    const total = p.input + p.output + p.cacheRead + p.cacheWrite;
    console.log(`  ${shortName}`);
    console.log(`    Sessions: ${p.sessions}  |  Tokens: ${formatNumber(total)}  |  Cost: ${formatCost(p.cost)}${p.subagents > 0 ? `  |  Subagents: ${p.subagents}` : ''}`);
  }
  console.log();

  // Top 15 most expensive sessions
  console.log('  ── Top 15 Most Expensive Sessions ──');
  for (const r of results.slice(0, 15)) {
    const date = r.firstTimestamp ? new Date(r.firstTimestamp).toLocaleDateString() : 'unknown';
    const shortProj = r.project.length > 30 ? '...' + r.project.slice(-27) : r.project;
    console.log(`  ${r.sessionId.slice(0, 8)}  ${date.padEnd(12)} ${shortProj.padEnd(32)} ${formatNumber(r.totalTokens).padStart(12)} tok  ${formatCost(r.estimatedCost).padStart(10)}  [${r.model}]${r.subagentCount > 0 ? ` +${r.subagentCount} sub` : ''}`);
  }
  console.log();
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(console.error);
